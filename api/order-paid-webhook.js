import crypto from "crypto";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const API_VERSION = "2024-04";

/* ------------------------------
   Verify Shopify webhook
------------------------------- */
function verifyWebhook(req, rawBody) {
  const hmac = req.headers["x-shopify-hmac-sha256"];

  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return digest === hmac;
}

/* ------------------------------
   Shopify GraphQL helper
------------------------------- */
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

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  let rawBody = "";

  req.on("data", chunk => {
    rawBody += chunk;
  });

  req.on("end", async () => {
    if (!verifyWebhook(req, rawBody)) {
      return res.status(401).send("Invalid webhook");
    }

    const order = JSON.parse(rawBody);

    for (const item of order.line_items) {
      const hasDimension =
        item.properties &&
        item.properties.some(p => p.name === "Dimensions");

      if (!hasDimension) continue;

      const quantity = item.quantity;

      /* -----------------------------------
         1. Reduce TEMP VARIANT inventory
      ------------------------------------ */
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
          id: `gid://shopify/InventoryItem/${item.inventory_item_id}`,
          delta: -quantity
        }
      );

      /* -----------------------------------
         2. Reduce ORIGINAL PRODUCT inventory
      ------------------------------------ */
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

    res.status(200).send("OK");
  });
}
