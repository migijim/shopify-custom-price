import crypto from "crypto";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const API_VERSION = "2024-04";

/* -------------------------------------------------
   Disable body parser (required for webhooks)
-------------------------------------------------- */
export const config = {
  api: {
    bodyParser: false
  }
};

/* -------------------------------------------------
   Verify Shopify webhook HMAC
-------------------------------------------------- */
function verifyWebhook(rawBody, shopifyHmac) {
  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  console.log("🔐 Shopify HMAC:", shopifyHmac);
  console.log("🔐 Calculated HMAC:", digest);

  return digest === shopifyHmac;
}

/* -------------------------------------------------
   Shopify GraphQL helper
-------------------------------------------------- */
async function shopifyFetch(query, variables = {}) {
  const res = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const json = await res.json();

  if (json.errors) {
    console.error("❌ Shopify GraphQL errors:", json.errors);
    throw json.errors;
  }

  return json.data;
}

/* -------------------------------------------------
   Get primary location ID
-------------------------------------------------- */
async function getPrimaryLocationId() {
  const data = await shopifyFetch(`
    query {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  `);

  const locationId = data.locations.edges[0].node.id;
  console.log("📍 Using location:", locationId);
  return locationId;
}

/* -------------------------------------------------
   Check if order already processed
-------------------------------------------------- */
async function isOrderProcessed(orderId) {
  const data = await shopifyFetch(
    `
    query ($id: ID!) {
      order(id: $id) {
        metafield(namespace: "custom_price_app", key: "inventory_processed") {
          value
        }
      }
    }
    `,
    { id: `gid://shopify/Order/${orderId}` }
  );

  return data.order.metafield !== null;
}

/* -------------------------------------------------
   Mark order as processed
-------------------------------------------------- */
async function markOrderAsProcessed(orderId) {
  const data = await shopifyFetch(
    `
    mutation ($input: MetafieldsSetInput!) {
      metafieldsSet(metafields: [$input]) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
    `,
    {
      input: {
        namespace: "custom_price_app",
        key: "inventory_processed",
        value: "true",
        type: "boolean",
        ownerId: `gid://shopify/Order/${orderId}`
      }
    }
  );

  const errors = data.metafieldsSet.userErrors;
  if (errors.length > 0) {
    console.error("❌ Failed to mark order as processed:", errors);
    throw new Error("Metafield write failed");
  }

  console.log("✅ Order marked as processed");
}

/* -------------------------------------------------
   Webhook handler
-------------------------------------------------- */
export default async function handler(req, res) {
  console.log("➡️ Order paid webhook received");

  let rawBody = "";

  req.on("data", chunk => {
    rawBody += chunk;
  });

  req.on("end", async () => {
    try {
      const shopifyHmac = req.headers["x-shopify-hmac-sha256"];

      if (!verifyWebhook(rawBody, shopifyHmac)) {
        console.error("❌ Webhook HMAC verification failed");
        return res.status(401).send("Unauthorized");
      }

      console.log("✅ Webhook verified");

      const order = JSON.parse(rawBody);
      const orderId = order.id;
      console.log("🧾 Order ID:", orderId);

      // -----------------------------
      // Step 6: Idempotency check
      // -----------------------------
      const alreadyProcessed = await isOrderProcessed(orderId);

      if (alreadyProcessed) {
        console.log("⏭ Order already processed, skipping inventory update");
        return res.status(200).send("OK");
      }

      const locationId = await getPrimaryLocationId();

      for (const item of order.line_items) {
        const hasDimension =
          Array.isArray(item.properties) &&
          item.properties.some(
            p =>
              p.name === "Individuelle Breite" ||
              p.name === "Individuelle Länge"
          );

        if (!hasDimension) {
          console.log("⏭ Skipped non-dimension item:", item.id);
          continue;
        }

        const quantity = item.quantity;

        console.log(
          `📦 Processing item ${item.id} | variant ${item.variant_id} | product ${item.product_id} | qty ${quantity}`
        );

        // -----------------------------
        // Get starter variant ID from variant metafield or line item property
        // -----------------------------
        let starterVariantId = null;
        
        // Method 1: Try to get from variant metafield (preferred)
        try {
          const variantData = await shopifyFetch(
            `
            query ($id: ID!) {
              productVariant(id: $id) {
                metafield(namespace: "custom_price_app", key: "starter_variant_id") {
                  value
                }
              }
            }
            `,
            { id: `gid://shopify/ProductVariant/${item.variant_id}` }
          );

          if (variantData.productVariant?.metafield?.value) {
            starterVariantId = variantData.productVariant.metafield.value;
            console.log(`✅ Found starter variant ID from metafield: ${starterVariantId}`);
          }
        } catch (err) {
          console.warn("⚠️ Could not fetch variant metafield:", err.message);
        }

        // Method 2: Fallback to line item property (for backward compatibility)
        if (!starterVariantId && Array.isArray(item.properties)) {
          const starterProp = item.properties.find(
            p => p.name === "_starter_variant_id" || p.name === "starter_variant_id"
          );
          if (starterProp) {
            // Extract numeric ID from GID if needed
            starterVariantId = starterProp.value.replace(/^gid:\/\/shopify\/ProductVariant\//, '');
            console.log(`✅ Found starter variant ID from line item property: ${starterVariantId}`);
          }
        }

        // Method 3: Fallback to first variant (backward compatibility for old orders)
        if (!starterVariantId) {
          console.warn("⚠️ No starter variant ID found, falling back to first variant");
          const productData = await shopifyFetch(
            `
            query ($id: ID!) {
              product(id: $id) {
                variants(first: 1) {
                  edges {
                    node {
                      inventoryItem {
                        id
                      }
                    }
                  }
                }
              }
            }
            `,
            { id: `gid://shopify/Product/${item.product_id}` }
          );
          const originalInventoryItemId =
            productData.product.variants.edges[0].node.inventoryItem.id;
          
          console.log(
            `📉 Reducing first variant inventory ${originalInventoryItemId} by ${quantity} (fallback)`
          );

          const result = await shopifyFetch(
            `
            mutation ($input: InventoryAdjustQuantitiesInput!) {
              inventoryAdjustQuantities(input: $input) {
                inventoryAdjustmentGroup {
                  createdAt
                }
                userErrors {
                  field
                  message
                }
              }
            }
            `,
            {
              input: {
                reason: "correction",
                name: "available",
                changes: [
                  {
                    inventoryItemId: originalInventoryItemId,
                    locationId,
                    delta: -quantity
                  }
                ]
              }
            }
          );

          const errors = result.inventoryAdjustQuantities.userErrors;
          if (errors.length > 0) {
            console.error("❌ Inventory errors:", errors);
            throw new Error("Inventory update failed");
          }

          console.log("✅ Inventory reduced successfully (fallback)");
          continue; // Skip to next item
        }

        // -----------------------------
        // Get inventory item ID from starter variant
        // -----------------------------
        const numericStarterVariantId = starterVariantId.toString();
        const starterVariantData = await shopifyFetch(
          `
          query ($id: ID!) {
            productVariant(id: $id) {
              inventoryItem {
                id
              }
            }
          }
          `,
          { id: `gid://shopify/ProductVariant/${numericStarterVariantId}` }
        );

        if (!starterVariantData.productVariant?.inventoryItem?.id) {
          console.error(`❌ Could not find inventory item for starter variant ${numericStarterVariantId}`);
          throw new Error(`Starter variant ${numericStarterVariantId} not found`);
        }

        const starterInventoryItemId = starterVariantData.productVariant.inventoryItem.id;

        console.log(
          `📉 Reducing starter variant ${numericStarterVariantId} inventory ${starterInventoryItemId} by ${quantity}`
        );

        // -----------------------------
        // Adjust inventory
        // -----------------------------
        const result = await shopifyFetch(
          `
          mutation ($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              inventoryAdjustmentGroup {
                createdAt
              }
              userErrors {
                field
                message
              }
            }
          }
          `,
          {
            input: {
              reason: "correction",
              name: "available",
              changes: [
                {
                  inventoryItemId: starterInventoryItemId,
                  locationId,
                  delta: -quantity
                }
              ]
            }
          }
        );

        const errors = result.inventoryAdjustQuantities.userErrors;
        if (errors.length > 0) {
          console.error("❌ Inventory errors:", errors);
          throw new Error("Inventory update failed");
        }

        console.log("✅ Inventory reduced successfully");
      }

      // -----------------------------
      // Step 6: Mark order as processed
      // -----------------------------
      await markOrderAsProcessed(orderId);

      console.log("✅ Order paid webhook completed");
      res.status(200).send("OK");
    } catch (err) {
      console.error("🔥 Webhook failure:", err);
      res.status(500).send("Internal Server Error");
    }
  });
}
