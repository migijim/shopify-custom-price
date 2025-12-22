import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, dimensionMm, quantity } = req.body;

    if (!productId || !dimensionMm || !quantity) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    /* 1. Get base price (price per meter) */
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
            query ($id: ID!) {
              product(id: $id) {
                title
                variants(first: 1) {
                  edges {
                    node {
                      price
                    }
                  }
                }
              }
            }
          `,
          variables: { id: productId }
        })
      }
    );

    const json = await response.json();

    const pricePerMeter = parseFloat(
      json.data.product.variants.edges[0].node.price
    );

    /* 2. Calculate price */
    const meters = dimensionMm / 1000;
    const unitPrice = Math.round(pricePerMeter * meters * 100) / 100;
    const totalPrice = Math.round(unitPrice * quantity * 100) / 100;

    /* 3. Return result */
    res.status(200).json({
      product: json.data.product.title,
      pricePerMeter,
      dimensionMm,
      meters,
      quantity,
      unitPrice,
      totalPrice
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Calculation failed" });
  }
}
