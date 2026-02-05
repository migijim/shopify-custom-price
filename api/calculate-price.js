// shopify-custom-price/api/calculate-price.js
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, mode, lengthMm, widthMm, quantity } = req.body;

    if (!productId || !mode || !quantity) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    if (mode === "area" && (!lengthMm || !widthMm)) {
      return res.status(400).json({ error: "Missing length/width for area mode" });
    }
    if (mode !== "area" && !lengthMm && !widthMm) {
      return res.status(400).json({ error: "Missing dimension (lengthMm or widthMm)" });
    }

    /* 1. Get base price (per meter or per m²) */
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
    const pricePerUnit = parseFloat(
      json.data.product.variants.edges[0].node.price
    );

    /* 2. Calculate price */
    const qty = Number(quantity);
    const lenM = lengthMm ? Number(lengthMm) / 1000 : null;
    const widM = widthMm ? Number(widthMm) / 1000 : null;

    let unitPrice;
    let calcDetails = {};

    if (mode === "area") {
      const areaSqm = Math.max(0, (lenM || 0) * (widM || 0));
      unitPrice = Math.round(pricePerUnit * areaSqm * 100) / 100;
      calcDetails = { areaSqm };
    } else {
      const dimensionM = lenM ?? widM;
      unitPrice = Math.round(pricePerUnit * dimensionM * 100) / 100;
      calcDetails = { meters: dimensionM };
    }

    const totalPrice = Math.round(unitPrice * qty * 100) / 100;

    /* 3. Return result */
    res.status(200).json({
      product: json.data.product.title,
      pricePerUnit,
      mode,
      lengthMm: lengthMm ?? null,
      widthMm: widthMm ?? null,
      quantity: qty,
      unitPrice,
      totalPrice,
      ...calcDetails
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Calculation failed" });
  }
}
