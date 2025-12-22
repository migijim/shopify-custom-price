import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

export default async function handler(req, res) {
  try {
    const response = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            query {
              shop {
                name
              }
            }
          `
        })
      }
    );

    const data = await response.json();

    res.status(200).json({
      success: true,
      shop: data.data.shop.name
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
