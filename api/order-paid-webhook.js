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
    console.error("✖ Shopify GraphQL errors:", json.errors);
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
        edges { node { id } }
      }
    }
  `);

  return data.locations.edges[0].node.id;
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
        metafields { id }
        userErrors { field message }
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
    console.error("✖ Failed to mark order as processed:", errors);
    throw new Error("Metafield write failed");
  }
}

/* -------------------------------------------------
   Webhook handler
-------------------------------------------------- */
export default async function handler(req, res) {
  let rawBody = "";

  req.on("data", chunk => {
    rawBody += chunk;
  });

  req.on("end", async () => {
    try {
      const shopifyHmac = req.headers["x-shopify-hmac-sha256"];
      if (!verifyWebhook(rawBody, shopifyHmac)) {
        console.error("✖ Webhook HMAC verification failed");
        return res.status(401).send("Unauthorized");
      }

      const order = JSON.parse(rawBody);
      const orderId = order.id;

      // Idempotency
      if (await isOrderProcessed(orderId)) {
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

        if (!hasDimension) continue;

        const quantity = item.quantity;

        // --- Starter variant lookup priority: metafield → line item prop → first variant
        let starterVariantId = null;

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
          }
        } catch (err) {
          console.warn("⚠ Could not fetch variant metafield:", err.message);
        }

        if (!starterVariantId && Array.isArray(item.properties)) {
          const starterProp = item.properties.find(
            p => p.name === "_starter_variant_id" || p.name === "starter_variant_id"
          );
          if (starterProp) {
            starterVariantId = starterProp.value.replace(
              /^gid:\/\/shopify\/ProductVariant\//,
              ""
            );
          }
        }

        if (!starterVariantId) {
          const productData = await shopifyFetch(
            `
            query ($id: ID!) {
              product(id: $id) {
                variants(first: 1) {
                  edges { node { inventoryItem { id } } }
                }
              }
            }
            `,
            { id: `gid://shopify/Product/${item.product_id}` }
          );

          const fallbackInventoryId =
            productData.product.variants.edges[0].node.inventoryItem.id;

          await shopifyFetch(
            `
            mutation ($input: InventoryAdjustQuantitiesInput!) {
              inventoryAdjustQuantities(input: $input) {
                userErrors { field message }
              }
            }
            `,
            {
              input: {
                reason: "correction",
                name: "available",
                changes: [
                  {
                    inventoryItemId: fallbackInventoryId,
                    locationId,
                    delta: -quantity
                  }
                ]
              }
            }
          );

          continue;
        }

        // Get inventory item of starter variant
        const starterVariantData = await shopifyFetch(
          `
          query ($id: ID!) {
            productVariant(id: $id) {
              inventoryItem { id }
            }
          }
          `,
          { id: `gid://shopify/ProductVariant/${starterVariantId}` }
        );

        const starterInventoryItemId =
          starterVariantData.productVariant?.inventoryItem?.id;

        if (!starterInventoryItemId) {
          throw new Error(`Starter variant ${starterVariantId} not found`);
        }

        // Adjust inventory
        const result = await shopifyFetch(
          `
          mutation ($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              userErrors { field message }
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
          console.error("✖ Inventory errors:", errors);
          throw new Error("Inventory update failed");
        }
      }

      await markOrderAsProcessed(orderId);
      res.status(200).send("OK");
    } catch (err) {
      console.error("🔥 Webhook failure:", err);
      res.status(500).send("Internal Server Error");
    }
  });
}
