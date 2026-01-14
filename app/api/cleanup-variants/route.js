import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-04";

const MAX_VARIANTS = Number(process.env.TEMP_VARIANT_MAX_COUNT || 100);
const BUFFER_MINUTES = Number(process.env.TEMP_VARIANT_BUFFER_MINUTES || 120);

/* -------------------------------
   Shopify GraphQL helper
-------------------------------- */
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
    console.error("❌ Shopify GraphQL errors:", json.errors);
    throw json.errors;
  }

  return json.data;
}

/* -------------------------------
   Helpers
-------------------------------- */
function isTemporaryVariant(title) {
  return title.startsWith("Length |") || title.startsWith("Width |");
}

function isOlderThanBuffer(createdAt) {
  const createdTime = new Date(createdAt).getTime();
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  return Date.now() - createdTime > bufferMs;
}

/* -------------------------------
   Cleanup logic per product
-------------------------------- */
async function cleanupProduct(product) {
  const tempVariants = product.variants.edges
    .map(e => e.node)
    .filter(v => isTemporaryVariant(v.title));

  if (tempVariants.length <= MAX_VARIANTS) {
    return;
  }

  console.log(
    `🧹 Product ${product.id} has ${tempVariants.length} temporary variants`
  );

  const deletable = tempVariants
    .filter(v => isOlderThanBuffer(v.createdAt))
    .sort(
      (a, b) =>
        new Date(a.createdAt) - new Date(b.createdAt)
    );

  const excessCount = tempVariants.length - MAX_VARIANTS;
  const toDelete = deletable.slice(0, excessCount);

  for (const variant of toDelete) {
    console.log(`🗑 Deleting ${variant.title} (${variant.id})`);

    await shopifyFetch(
      `
      mutation ($id: ID!) {
        productVariantDelete(id: $id) {
          deletedProductVariantId
          userErrors {
            message
          }
        }
      }
      `,
      { id: variant.id }
    );
  }
}

/* -------------------------------
   Cron entrypoint
-------------------------------- */
export async function GET() {
  console.log("⏱ Variant cleanup job started");

  try {
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await shopifyFetch(
        `
        query ($cursor: String) {
          products(first: 20, after: $cursor) {
            edges {
              cursor
              node {
                id
                variants(first: 250) {
                  edges {
                    node {
                      id
                      title
                      createdAt
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
        `,
        { cursor }
      );

      for (const edge of data.products.edges) {
        await cleanupProduct(edge.node);
      }

      hasNextPage = data.products.pageInfo.hasNextPage;
      cursor = data.products.edges.at(-1)?.cursor || null;
    }

    console.log("✅ Variant cleanup completed");
    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("🔥 Cleanup failed:", err);
    return new Response("Cleanup failed", { status: 500 });
  }
}
