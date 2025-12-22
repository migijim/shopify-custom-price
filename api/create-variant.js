import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

const shopifyFetch = async (query, variables = {}) => {
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
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, dimensionMm } = req.body;

    if (!productId || !dimensionMm) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    /* 1. Get base price */
    const productData = await shopifyFetch(`
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
    `, { id: productId });

    const pricePerMeter = parseFloat(
      productData.product.variants.edges[0].node.price
    );

    /* 2. Calculate price */
    const meters = dimensionMm / 1000;
    const unitPrice = Math.round(pricePerMeter * meters * 100) / 100;

    /* 3. Create variant */
    const createVariant = await shopifyFetch(`
      mutation ($input: ProductVariantInput!) {
        productVariantCreate(input: $input) {
          productVariant {
            id
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
    `, {
      input: {
        productId,
        title: `${dimensionMm}mm`,
        price: unitPrice.toString(),
        inventoryPolicy: "CONTINUE",
        inventoryManagement: "SHOPIFY"
      }
    });

    const errors = createVariant.productVariantCreate.userErrors;
    if (errors.length) {
      return res.status(400).json({ errors });
    }

    const variant =
      createVariant.productVariantCreate.productVariant;

    /* 4. Get primary location */
    const locationData = await shopifyFetch(`
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

    const locationId =
      locationData.locations.edges[0].node.id;

    /* 5. Set inventory to 0 at location */
    await shopifyFetch(`
      mutation ($inventoryItemId: ID!, $locationId: ID!) {
        inventoryAdjustQuantity(
          input: {
            inventoryItemId: $inventoryItemId
            locationId: $locationId
            availableDelta: 0
          }
        ) {
          inventoryLevel {
            available
          }
        }
      }
    `, {
      inventoryItemId: variant.inventoryItem.id,
      locationId
    });

    res.status(200).json({
      variantId: variant.id,
      price: unitPrice,
      dimensionMm
    });

  } catch (err) {
    console.error("SHOPIFY ERROR:", err);
    res.status(500).json({ error: "Variant creation failed" });
  }
}
