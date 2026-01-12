import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

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

export default async function handler(req, res) {
  try {
    const data = await shopifyFetch(
      `
      mutation {
        webhookSubscriptionCreate(
          topic: ORDERS_PAID
          webhookSubscription: {
            callbackUrl: "https://shopify-custom-price.vercel.app/api/order-paid-webhook"
            format: JSON
          }
        ) {
          webhookSubscription {
            id
          }
          userErrors {
            message
          }
        }
      }
      `
    );

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
}
