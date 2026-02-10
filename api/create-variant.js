import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, selectedVariantId, mode, lengthMm, widthMm } = req.body;

    if (!productId || !mode) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    if (mode === "area") {
      if (!lengthMm || !widthMm) {
        return res.status(400).json({ error: "Length and width are required for area mode" });
      }
    } else if (mode === "length" || mode === "width") {
      const dim = mode === "length" ? lengthMm : widthMm;
      if (!dim) return res.status(400).json({ error: `Missing ${mode}Mm` });
    } else {
      return res.status(400).json({ error: "Invalid mode" });
    }

    /* 1. Base price from selected variant (or first) */
    const numericProductId = productId.split("/").pop();
    let pricePerUnit;
    let starterVariantId;

    const fetchFirstVariantPrice = async () => {
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
                    edges { node { id price } }
                  }
                }
              }
            `,
            variables: { id: productId }
          })
        }
      );
      const gqlJson = await gqlResp.json();
      pricePerUnit = parseFloat(gqlJson.data.product.variants.edges[0].node.price);
      const firstVariantGid = gqlJson.data.product.variants.edges[0].node.id;
      starterVariantId = firstVariantGid.split("/").pop();
    };

    if (selectedVariantId) {
      const numericVariantId = selectedVariantId
        .toString()
        .replace(/^gid:\/\/shopify\/ProductVariant\//, "");
      const variantResp = await fetch(
        `https://${SHOP}/admin/api/${API_VERSION}/variants/${numericVariantId}.json`,
        { headers: { "X-Shopify-Access-Token": TOKEN } }
      );
      if (variantResp.ok) {
        const variantJson = await variantResp.json();
        pricePerUnit = parseFloat(variantJson.variant.price);
        starterVariantId = numericVariantId;
      } else {
        await fetchFirstVariantPrice();
      }
    } else {
      await fetchFirstVariantPrice();
    }

    /* 1.5 Price calc + title */
    const lenM = lengthMm ? Number(lengthMm) / 1000 : null;
    const widM = widthMm ? Number(widthMm) / 1000 : null;

    let unitPrice;
    let variantOptionValue;

    if (mode === "area") {
      const areaSqM = (lenM || 0) * (widM || 0);
      unitPrice = Math.round(pricePerUnit * areaSqM * 100) / 100;
      variantOptionValue = `Length | ${lengthMm} mm X Width | ${widthMm} mm`;
    } else {
      const dimMm = mode === "length" ? lengthMm : widthMm;
      const meters = Number(dimMm) / 1000;
      unitPrice = Math.round(pricePerUnit * meters * 100) / 100;
      const label = mode === "length" ? "Length" : "Width";
      variantOptionValue = `${label} | ${dimMm} mm`;
    }

    /* 2. Ensure options */
    const productResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${numericProductId}.json`,
      { headers: { "X-Shopify-Access-Token": TOKEN } }
    );
    const productJson = await productResp.json();
    let optionName = "Dimensions";

    if (
      productJson.product.options.length === 1 &&
      productJson.product.options[0].name === "Title"
    ) {
      await fetch(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${numericProductId}.json`,
        {
          method: "PUT",
          headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            product: { id: numericProductId, options: [{ name: optionName }] }
          })
        }
      );
    } else {
      optionName = productJson.product.options[0].name;
    }

    /* 2.5 Existing variant check */
    const existingVariant = productJson.product.variants.find(
      v => v.option1 === variantOptionValue
    );
    if (existingVariant) {
      return res.status(200).json({
        success: true,
        variantId: existingVariant.id,
        price: existingVariant.price,
        lengthMm: lengthMm ?? null,
        widthMm: widthMm ?? null,
        mode,
        isExisting: true
      });
    }

    /* 3. Create variant (no tracking) */
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
            inventory_management: null,   // <-- disable tracking
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

    /* 3.5 Store starter variant metafield */
    const variantGid = `gid://shopify/ProductVariant/${variant.id}`;
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
            mutation ($input: MetafieldsSetInput!) {
              metafieldsSet(metafields: [$input]) {
                metafields { id }
                userErrors { field message }
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

    /* 5. Success */
    res.status(200).json({
      success: true,
      variantId: variant.id,
      price: unitPrice,
      lengthMm: lengthMm ?? null,
      widthMm: widthMm ?? null,
      mode
    });
  } catch (err) {
    console.error("Variant creation failed:", err);
    res.status(500).json({ error: "Variant creation failed", details: err.message });
  }
}
