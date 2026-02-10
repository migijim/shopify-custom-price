import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

const MAX_VARIANTS = Number(process.env.TEMP_VARIANT_MAX_COUNT || 100);
const BUFFER_MINUTES = Number(process.env.TEMP_VARIANT_BUFFER_MINUTES || 120);

/* -------------------------------------------------
   Shopify GraphQL helper
-------------------------------------------------- */
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

  if (json.errors) {
    console.error("✖ Shopify GraphQL errors:", json.errors);
    throw json.errors;
  }

  return json.data;
}

/* -------------------------------------------------
   Helpers
-------------------------------------------------- */
// const tempTitleRegex =
//   /^(Length|Width)\s*\|\s*\d+\s*mm(\s*X\s*Width\s*\|\s*\d+\s*mm|\s*X\s*Length\s*\|\s*\d+\s*mm)?$/i;

const tempTitleRegex = /^(Länge|Breite|Length|Width)\s*\|\s*\d+\s*mm(\s*X\s*(Länge|Breite|Length|Width)\s*\|\s*\d+\s*mm)?$/i;

function isTemporaryVariant(title) {
  return tempTitleRegex.test(title);
}

function isOlderThanBuffer(createdAt) {
  const createdTime = new Date(createdAt).getTime();
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  return Date.now() - createdTime > bufferMs;
}

/* -------------------------------------------------
   Cleanup logic
-------------------------------------------------- */
async function cleanupProductVariants(product) {
  const tempVariants = product.variants.edges
    .map(e => e.node)
    .filter(v => isTemporaryVariant(v.title));

  if (tempVariants.length <= MAX_VARIANTS) return;

  const deletable = tempVariants
    .filter(v => isOlderThanBuffer(v.createdAt))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const excessCount = tempVariants.length - MAX_VARIANTS;
  const toDelete = deletable.slice(0, excessCount);

  if (toDelete.length === 0) {
    console.log("⚠ No variants eligible for deletion yet (buffer time)");
    return;
  }

  const variantsIds = toDelete.map(v => v.id);

  const result = await shopifyFetch(
    `
    mutation ($productId: ID!, $variantsIds: [ID!]!) {
      productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
        userErrors { field message }
      }
    }
    `,
    { productId: product.id, variantsIds }
  );

  const errors = result.productVariantsBulkDelete.userErrors;
  if (errors.length > 0) {
    console.error("✖ Bulk delete errors:", errors);
    throw new Error("Bulk variant delete failed");
  }

  console.log(`✔ Deleted ${variantsIds.length} variants`);
}

/* -------------------------------------------------
   Cron handler
-------------------------------------------------- */
export default async function handler(req, res) {
  console.log("⏱ Variant cleanup job started");

  try {
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const data = await shopifyFetch(
        `
        query ($cursor: String) {
          products(first: 20, after: $cursor) {
            edges {
              node {
                id
                variants(first: 250) {
                  edges { node { id title createdAt } }
                }
              }
              cursor
            }
            pageInfo { hasNextPage }
          }
        }
        `,
        { cursor }
      );

      for (const edge of data.products.edges) {
        await cleanupProductVariants(edge.node);
      }

      hasNextPage = data.products.pageInfo.hasNextPage;
      cursor = data.products.edges.at(-1)?.cursor || null;
    }

    console.log("✔ Variant cleanup completed");
    res.status(200).send("OK");
  } catch (err) {
    console.error("🔥 Cleanup failed:", err);
    res.status(500).send("Cleanup failed");
  }
}
