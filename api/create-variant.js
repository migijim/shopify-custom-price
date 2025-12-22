import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, dimensionMm } = req.body;

    if (!productId || !dimensionMm) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    /* 1. Read base price */
    const productResp = await fetch(
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
                      inventoryItem {
                        id
                      }
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

    const productJson = await productResp.json();
    const baseVariant =
      productJson.data.product.variants.edges[0].node;

    const pricePerMeter = parseFloat(baseVariant.price);

    /* 2. Calculate price */
    const meters = dimensionMm / 1000;
    const unitPrice = Math.round(pricePerMeter * meters * 100) / 100;

    /* 3. Create variant */
    const createResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            mutation ($input: ProductVariantInput!) {
              productVariantCreate(input: $input) {
                productVariant {
                  id
                  price
                  inventoryItem {
                    id
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          variables: {
            input: {
              productId,
              title: `${dimensionMm}mm`,
              price: unitPrice.toString(),
              inventoryPolicy: "CONTINUE",
              inventoryManagement: "SHOPIFY"
            }
          }
        })
      }
    );

    const createJson = await createResp.json();

    const errors = createJson.data.productVariantCreate.userErrors;
    if (errors.length) {
      return res.status(400).json({ errors });
    }

    const variant =
      createJson.data.productVariantCreate.productVariant;

    /* 4. Set inventory to 0 */
    await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            mutation ($id: ID!) {
              inventoryAdjustQuantity(
                input: {
                  inventoryItemId: $id
                  availableDelta: 0
                }
              ) {
                inventoryLevel {
                  available
                }
              }
            }
          `,
          variables: {
            id: variant.inventoryItem.id
          }
        })
      }
    );

    /* 5. Return result */
    res.status(200).json({
      variantId: variant.id,
      price: unitPrice,
      dimensionMm
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Variant creation failed" });
  }
}
