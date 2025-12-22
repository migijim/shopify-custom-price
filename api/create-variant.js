import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-01";

async function shopifyFetch(label, query, variables = {}) {
  console.log(`\n🔹 SHOPIFY CALL: ${label}`);
  console.log("Variables:", JSON.stringify(variables));

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
  console.log(`Response (${label}):`, JSON.stringify(json));

  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }

  return json.data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, dimensionMm } = req.body;
    console.log("Incoming body:", req.body);

    if (!productId || !dimensionMm) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    /* 1️⃣ Read base product price */
    const productData = await shopifyFetch(
      "READ_PRODUCT",
      `
      query ($id: ID!) {
        product(id: $id) {
          status
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
      { id: productId }
    );

    if (productData.product.status !== "ACTIVE") {
      throw new Error("Product is not ACTIVE");
    }

    const pricePerMeter = parseFloat(
      productData.product.variants.edges[0].node.price
    );

    console.log("Price per meter:", pricePerMeter);

    /* 2️⃣ Calculate unit price */
    const meters = dimensionMm / 1000;
    const unitPrice = Math.round(pricePerMeter * meters * 100) / 100;

    console.log("Calculated unit price:", unitPrice);

    /* 3️⃣ Create variant */
    const createVariantData = await shopifyFetch(
      "CREATE_VARIANT",
      `
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
      `,
      {
        input: {
          productId,
          title: `${dimensionMm}mm`,
          price: unitPrice.toString(),
          inventoryPolicy: "CONTINUE",
          inventoryManagement: "SHOPIFY"
        }
      }
    );

    const userErrors =
      createVariantData.productVariantCreate.userErrors;

    if (userErrors.length) {
      console.error("Variant userErrors:", userErrors);
      return res.status(400).json({ userErrors });
    }

    const variant =
      createVariantData.productVariantCreate.productVariant;

    console.log("Created variant ID:", variant.id);

    /* 4️⃣ Fetch location */
    const locationData = await shopifyFetch(
      "FETCH_LOCATION",
      `
      query {
        locations(first: 1) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
      `
    );

    const locationId =
      locationData.locations.edges[0].node.id;

    console.log("Using location:", locationId);

    /* 5️⃣ Set inventory to 0 */
    await shopifyFetch(
      "SET_INVENTORY",
      `
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
      `,
      {
        inventoryItemId: variant.inventoryItem.id,
        locationId
      }
    );

    console.log("Inventory set to 0");

    res.status(200).json({
      success: true,
      variantId: variant.id,
      unitPrice
    });

  } catch (err) {
    console.error("❌ STEP 3 FAILED:", err.message);
    res.status(500).json({
      error: "Variant creation failed",
      details: err.message
    });
  }
}
