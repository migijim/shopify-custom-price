import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2025-01";

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
    console.error("❌ Shopify GraphQL errors:", json.errors);
    throw json.errors;
  }

  return json.data;
}

/* -------------------------------------------------
   Helpers
-------------------------------------------------- */
function isTemporaryVariant(title) {
  return (
    title.startsWith("Length |") ||
    title.startsWith("Width |")
  );
}

function isOlderThanBuffer(createdAt) {
  const createdTime = new Date(createdAt).getTime();
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  return Date.now() - createdTime > bufferMs;
}

/* -------------------------------------------------
   Cleanup logic
-------------------------------------------------- */
// async function cleanupProductVariants(product) {
//   const tempVariants = product.variants.edges
//     .map(e => e.node)
//     .filter(v => isTemporaryVariant(v.title));

//   if (tempVariants.length <= MAX_VARIANTS) {
//     return;
//   }

//   console.log(
//     `🧹 Product ${product.id}: ${tempVariants.length} temporary variants`
//   );

//   const deletable = tempVariants
//     .filter(v => isOlderThanBuffer(v.createdAt))
//     .sort(
//       (a, b) =>
//         new Date(a.createdAt) - new Date(b.createdAt)
//     );

//   const excessCount =
//     tempVariants.length - MAX_VARIANTS;

//   const toDelete = deletable.slice(0, excessCount);

//   for (const variant of toDelete) {
//     console.log(
//       `🗑 Deleting variant ${variant.id} (${variant.title})`
//     );

//     await shopifyFetch(
//       `
//       mutation ($id: ID!) {
//         productVariantDelete(id: $id) {
//           deletedProductVariantId
//           userErrors {
//             message
//           }
//         }
//       }
//       `,
//       { id: variant.id }
//     );
//   }
// }

async function cleanupProductVariants(product) {
  const tempVariants = product.variants.edges
    .map(e => e.node)
    .filter(v => isTemporaryVariant(v.title));

  if (tempVariants.length <= MAX_VARIANTS) {
    return;
  }

  console.log(
    `🧹 Product ${product.id}: ${tempVariants.length} temporary variants`
  );

  // Filter variants that are older than buffer time
  const deletable = tempVariants
    .filter(v => isOlderThanBuffer(v.createdAt))
    .sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

  const excessCount = tempVariants.length - MAX_VARIANTS;
  const toDelete = deletable.slice(0, excessCount);

  if (toDelete.length === 0) {
    console.log("⚠️ No variants eligible for deletion yet (buffer time)");
    return;
  }

  const idsToDelete = toDelete.map(v => v.id);

  console.log(`🗑 Deleting ${idsToDelete.length} variants:`, idsToDelete);

  // const result = await shopifyFetch(
  //   `
  //   mutation ($ids: [ID!]!) {
  //     productVariantBulkDelete(ids: $ids) {
  //       deletedProductVariantIds
  //       userErrors {
  //         field
  //         message
  //       }
  //     }
  //   }
  //   `,
  //   { ids: idsToDelete }
  // );

  // const errors = result.productVariantBulkDelete.userErrors;
  // if (errors.length > 0) {
  //   console.error("❌ Bulk delete errors:", errors);
  //   throw new Error("Bulk variant delete failed");
  // }

  // console.log(
  //   "✅ Deleted variants:",
  //   result.productVariantBulkDelete.deletedProductVariantIds
  // );

  const result = await shopifyFetch(
    `
    mutation ($variantIds: [ID!]!) {
      productVariantsDelete(variantIds: $variantIds) {
        deletedProductVariantIds
        userErrors {
          field
          message
        }
      }
    }
    `,
    { variantIds: idsToDelete }
  );

  const errors = result.productVariantsDelete.userErrors;
  if (errors.length > 0) {
    console.error("❌ Bulk delete errors:", errors);
    throw new Error("Bulk variant delete failed");
  }

  console.log(
    "✅ Deleted variants:",
    result.productVariantsDelete.deletedProductVariantIds
  );
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
                  edges {
                    node {
                      id
                      title
                      createdAt
                    }
                  }
                }
              }
              cursor
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
        await cleanupProductVariants(edge.node);
      }

      hasNextPage = data.products.pageInfo.hasNextPage;
      cursor =
        data.products.edges.at(-1)?.cursor || null;
    }

    console.log("✅ Variant cleanup completed");
    res.status(200).send("OK");
  } catch (err) {
    console.error("🔥 Cleanup failed:", err);
    res.status(500).send("Cleanup failed");
  }
}
