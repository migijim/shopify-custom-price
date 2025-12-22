import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-01";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, dimensionMm } = req.body;

    if (!productId || !dimensionMm) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    /* -----------------------------
       1. Read base price (GraphQL)
    ----------------------------- */
    const gqlResp = await fetch(
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

    const gqlJson = await gqlResp.json();
    const pricePerMeter = parseFloat(
      gqlJson.data.product.variants.edges[0].node.price
    );

    const meters = Number(dimensionMm) / 1000;
    const unitPrice = Math.round(pricePerMeter * meters * 100) / 100;

    /* -----------------------------
       2. Create variant (REST)
    ----------------------------- */
    const numericProductId = productId.split("/").pop();

    const createVariantResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${numericProductId}/variants.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          variant: {
            title: `${dimensionMm}mm`,
            price: unitPrice,
            inventory_management: "shopify",
            inventory_policy: "continue"
          }
        })
      }
    );

    const createVariantJson = await createVariantResp.json();

    if (!createVariantResp.ok) {
      console.error("Variant REST error:", createVariantJson);
      return res.status(400).json(createVariantJson);
    }

    const variant = createVariantJson.variant;

    /* -----------------------------
       3. Set inventory = 0
    ----------------------------- */
    const locationsResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/locations.json`,
      {
        headers: {
          "X-Shopify-Access-Token": TOKEN
        }
      }
    );

    const locationsJson = await locationsResp.json();
    const locationId = locationsJson.locations[0].id;

    await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          location_id: locationId,
          inventory_item_id: variant.inventory_item_id,
          available: 0
        })
      }
    );

    /* -----------------------------
       4. Success
    ----------------------------- */
    res.status(200).json({
      success: true,
      variantId: variant.id,
      price: unitPrice,
      dimensionMm
    });

  } catch (err) {
    console.error("STEP 3 ERROR:", err);
    res.status(500).json({
      error: "Variant creation failed",
      details: err.message
    });
  }
}
