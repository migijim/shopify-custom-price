import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-01";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, dimensionMm, dimensionLang, selectedVariantId } = req.body;

    if (!productId || !dimensionMm) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    /* --------------------------------
       1. Read base price from SELECTED variant (or first if not provided)
    -------------------------------- */
    const numericProductId = productId.split("/").pop();
    
    // If selectedVariantId is provided, use it; otherwise use first variant
    let pricePerMeter;
    let starterVariantId;
    
    if (selectedVariantId) {
      // Get selected variant's price
      const numericVariantId = selectedVariantId.toString().replace(/^gid:\/\/shopify\/ProductVariant\//, '');
      
      const variantResp = await fetch(
        `https://${SHOP}/admin/api/${API_VERSION}/variants/${numericVariantId}.json`,
        {
          headers: {
            "X-Shopify-Access-Token": TOKEN
          }
        }
      );
      
      if (variantResp.ok) {
        const variantJson = await variantResp.json();
        pricePerMeter = parseFloat(variantJson.variant.price);
        starterVariantId = numericVariantId;
        console.log(`✅ Using selected variant ${starterVariantId} with price ${pricePerMeter}`);
      } else {
        // Fallback to first variant if selected variant not found
        console.warn(`⚠️ Selected variant ${numericVariantId} not found, falling back to first variant`);
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
                          id
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
        pricePerMeter = parseFloat(gqlJson.data.product.variants.edges[0].node.price);
        const firstVariantGid = gqlJson.data.product.variants.edges[0].node.id;
        starterVariantId = firstVariantGid.split("/").pop();
      }
    } else {
      // No selected variant provided - use first variant (backward compatibility)
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
                        id
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
      pricePerMeter = parseFloat(gqlJson.data.product.variants.edges[0].node.price);
      const firstVariantGid = gqlJson.data.product.variants.edges[0].node.id;
      starterVariantId = firstVariantGid.split("/").pop();
    }

    const meters = Number(dimensionMm) / 1000;
    const unitPrice = Math.round(pricePerMeter * meters * 100) / 100;

    /* --------------------------------
       2. Get product options (REST)
    -------------------------------- */
    const productResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${numericProductId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": TOKEN
        }
      }
    );

    const productJson = await productResp.json();
    let optionName = "Dimensions";

    if (productJson.product.options.length === 1 &&
        productJson.product.options[0].name === "Title") {
      // Product has Default Title only → replace option
      await fetch(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${numericProductId}.json`,
        {
          method: "PUT",
          headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            product: {
              id: numericProductId,
              options: [{ name: optionName }]
            }
          })
        }
      );
    } else {
      optionName = productJson.product.options[0].name;
    }

    /* --------------------------------
       2.5. Check if variant already exists
    -------------------------------- */
    const variantOptionValue = `${dimensionLang} | ${dimensionMm} mm`;
    const existingVariant = productJson.product.variants.find(
      (v) => v.option1 === variantOptionValue
    );

    if (existingVariant) {
      console.log("Variant already exists:", existingVariant.id);
      return res.status(200).json({
        success: true,
        variantId: existingVariant.id,
        price: existingVariant.price,
        dimensionMm,
        isExisting: true
      });
    }

    /* --------------------------------
       3. Create variant (REST)
    -------------------------------- */
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
            option1: variantOptionValue,
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

    /* --------------------------------
       3.5. Store starter variant ID as metafield on temporary variant
    -------------------------------- */
    const variantGid = `gid://shopify/ProductVariant/${variant.id}`;
    
    const metafieldResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            mutation ($input: MetafieldsSetInput!) {
              metafieldsSet(metafields: [$input]) {
                metafields {
                  id
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
              namespace: "custom_price_app",
              key: "starter_variant_id",
              value: starterVariantId.toString(),
              type: "single_line_text_field",
              ownerId: variantGid
            }
          }
        })
      }
    );

    const metafieldJson = await metafieldResp.json();
    if (metafieldJson.errors || metafieldJson.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error("⚠️ Failed to set starter variant metafield:", metafieldJson.errors || metafieldJson.data.metafieldsSet.userErrors);
      // Don't fail the request, just log the error
    } else {
      console.log(`✅ Stored starter variant ID ${starterVariantId} as metafield on variant ${variant.id}`);
    }

    /* --------------------------------
       4. Set inventory = 0
    -------------------------------- */
    const locationsResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/locations.json`,
      {
        headers: {
          "X-Shopify-Access-Token": TOKEN
        }
      }
    );

    const locationsJson = await locationsResp.json();
    const locations = locationsJson.locations || [];

    if (locations.length > 0) {
      const locationId = locations[0].id;

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
    } else {
      console.warn("⚠️ No inventory locations found. Skipping inventory set.");
    }

    /* --------------------------------
       5. Success
    -------------------------------- */
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