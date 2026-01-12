import crypto from "crypto";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const API_VERSION = "2024-04";

/* -------------------------------------------------
   IMPORTANT: Disable body parser for raw body
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
  if (json.errors) throw json.errors;
  return json.data;
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
    const shopifyHmac = req.headers["x-shopify-hmac-sha256"];

    if (!verifyWebhook(rawBody, shopifyHmac)) {
      console.error("❌ Webhook HMAC verification failed");
      return res.status(401).send("Unauthorized");
    }

    console.log("✅ Webhook verified");

    const order = JSON.parse(rawBody);
    console.log("🧾 Order ID:", order.id);

    for (const item of order.line_items) {
      const hasDimension =
        item.properties &&
        item.properties.some(p => p.name === "Dimensions");

      if (!hasDimension) {
        console.log("⏭ Skipped non-dimension item:", item.id);
        continue;
      }

      const quantity = item.quantity;
      console.log(
        `📦 Processing item ${item.id} | product ${item.product_id} | qty ${quantity}`
      );

      /* -----------------------------------------
         Reduce ORIGINAL product inventory only
         (temporary variant is auto-reduced by Shopify)
      ------------------------------------------ */
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
        {
          id: `gid://shopify/Product/${item.product_id}`
        }
      );

      const originalInventoryItemId =
        productData.product.variants.edges[0].node.inventoryItem.id;

      console.log(
        `📉 Reducing original inventory item ${originalInventoryItemId} by ${quantity}`
      );

      await shopifyFetch(
        `
        mutation ($id: ID!, $delta: Int!) {
          inventoryAdjustQuantity(
            input: {
              inventoryItemId: $id
              availableDelta: $delta
            }
          ) {
            inventoryLevel {
              available
            }
          }
        }
        `,
        {
          id: originalInventoryItemId,
          delta: -quantity
        }
      );
    }

    console.log("✅ Order paid webhook completed");
    res.status(200).send("OK");
  });
}
