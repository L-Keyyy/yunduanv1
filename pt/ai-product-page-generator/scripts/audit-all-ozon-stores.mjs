#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const appSecret = process.env.APP_SECRET || "replace-with-your-own-long-secret";
const outputPath = process.argv[2] || "storage/ozon-store-audit.json";
const goalOfferPrefix = process.env.OZON_AUDIT_OFFER_PREFIX || "RR500-";

function decrypt(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || "").split(":");
  const key = crypto.createHash("sha256").update(appSecret).digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

function primaryImage(item) {
  return Array.isArray(item?.primary_image)
    ? String(item.primary_image[0] || "")
    : String(item?.primary_image || "");
}

function processedPrimaryImage(item) {
  return Array.isArray(item?.primary_photo)
    ? String(item.primary_photo[0] || "")
    : "";
}

function processedPictureImages(item) {
  return Array.from(new Set([
    ...(Array.isArray(item?.primary_photo) ? item.primary_photo : []),
    ...(Array.isArray(item?.color_photo) ? item.color_photo : []),
    ...(Array.isArray(item?.photo) ? item.photo : []),
  ].map((value) => String(value || "")).filter(Boolean)));
}

async function isReachableImage(url) {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const response = await fetch(url, {
      headers: {
        Range: "bytes=0-2047",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const ready = response.ok
      && String(response.headers.get("content-type") || "").startsWith("image/");
    await response.body?.cancel().catch(() => undefined);
    return ready;
  } catch {
    return false;
  }
}

async function sellerRequest(store, apiKey, endpoint, body) {
  const response = await fetch(`${store.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Client-Id": store.clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function auditStore(store) {
  const apiKey = decrypt(store.apiKeyEncrypted);
  const firstPage = await sellerRequest(store, apiKey, "/v3/product/list", {
    filter: { visibility: "ALL" },
    last_id: "",
    limit: 1000,
  });
  const firstResult = firstPage.result || firstPage;
  const items = [...(firstResult.items || [])];
  let lastId = String(firstResult.last_id || "");
  while (lastId && items.length < Number(firstResult.total || 0)) {
    const page = await sellerRequest(store, apiKey, "/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    });
    const result = page.result || page;
    const next = result.items || [];
    if (!next.length) break;
    items.push(...next);
    const nextLastId = String(result.last_id || "");
    if (!nextLastId || nextLastId === lastId) break;
    lastId = nextLastId;
  }

  let limit = null;
  try {
    limit = await sellerRequest(store, apiKey, "/v4/product/info/limit", {});
  } catch (error) {
    limit = { error: error instanceof Error ? error.message : String(error) };
  }
  let warehouses = [];
  try {
    const warehousePayload = await sellerRequest(
      store,
      apiKey,
      "/v2/warehouse/list",
      {},
    );
    const raw = Array.isArray(warehousePayload?.result)
      ? warehousePayload.result
      : warehousePayload?.result?.warehouses
        || warehousePayload?.result?.items
        || warehousePayload?.warehouses
        || warehousePayload?.items
        || [];
    warehouses = raw.map((warehouse) => ({
      id: String(warehouse.warehouse_id || warehouse.id || ""),
      name: String(warehouse.name || warehouse.warehouse_name || ""),
      status: String(warehouse.status || ""),
    }));
  } catch (error) {
    warehouses = [{ error: error instanceof Error ? error.message : String(error) }];
  }

  const goalProducts = items.filter((item) =>
    String(item.offer_id || "").startsWith(goalOfferPrefix),
  );
  const goalInfo = [];
  for (let index = 0; index < goalProducts.length; index += 100) {
    const offerIds = goalProducts
      .slice(index, index + 100)
      .map((item) => String(item.offer_id || ""));
    const payload = await sellerRequest(store, apiKey, "/v3/product/info/list", {
      offer_id: offerIds,
    });
    goalInfo.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  const pictureInfo = [];
  const createdProductIds = goalInfo
    .filter((item) => item?.statuses?.is_created === true)
    .map((item) => String(item.id || item.product_id || ""))
    .filter(Boolean);
  for (let index = 0; index < createdProductIds.length; index += 100) {
    const payload = await sellerRequest(store, apiKey, "/v2/product/pictures/info", {
      product_id: createdProductIds.slice(index, index + 100).map(Number),
    });
    pictureInfo.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  const pictureByProduct = new Map(
    pictureInfo.map((item) => [String(item.product_id || ""), item]),
  );
  const processedPrimaryUrls = Array.from(new Set(
    pictureInfo.map(processedPrimaryImage).filter(Boolean),
  ));
  const reachablePrimary = new Map();
  for (let index = 0; index < processedPrimaryUrls.length; index += 25) {
    const batch = processedPrimaryUrls.slice(index, index + 25);
    const values = await Promise.all(
      batch.map(async (url) => [url, await isReachableImage(url)]),
    );
    for (const [url, reachable] of values) reachablePrimary.set(url, reachable);
  }
  const statusCounts = {};
  const errorCounts = {};
  let productsWithImages = 0;
  let productsWithoutImages = 0;
  let createdProducts = 0;
  let createdProductsWithoutImages = 0;
  let createdDisplayReady = 0;
  let createdDisplayBroken = 0;
  let processedImagesTotal = 0;
  for (const item of goalInfo) {
    const status = String(
      item?.statuses?.moderate_status
      || item?.statuses?.status_name
      || item?.statuses?.status
      || "unknown",
    );
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    for (const error of item.errors || []) {
      const code = String(error.code || "unknown");
      errorCounts[code] = (errorCounts[code] || 0) + 1;
    }
    const primaryImageUrl = primaryImage(item);
    const imageCount = (Array.isArray(item.images) ? item.images.length : 0)
      + (primaryImageUrl ? 1 : 0);
    if (imageCount > 0) productsWithImages += 1;
    else productsWithoutImages += 1;
    if (item?.statuses?.is_created === true) {
      createdProducts += 1;
      if (imageCount === 0) createdProductsWithoutImages += 1;
      const productId = String(item.id || item.product_id || "");
      const picture = pictureByProduct.get(productId);
      const processedPrimary = processedPrimaryImage(picture);
      const hasImageError = (item.errors || []).some((error) =>
        /image/i.test(String(error?.code || "")),
      );
      const displayReady = Boolean(
        processedPrimary && reachablePrimary.get(processedPrimary) && !hasImageError,
      );
      processedImagesTotal += processedPictureImages(picture).length;
      if (displayReady) createdDisplayReady += 1;
      else createdDisplayBroken += 1;
    }
  }

  return {
    configId: store.id,
    name: store.name,
    clientId: store.clientId,
    active: store.isActive,
    total: Number(firstResult.total ?? items.length),
    fetched: items.length,
    goal: {
      offerPrefix: goalOfferPrefix,
      listed: goalProducts.length,
      infoFound: goalInfo.length,
      statusCounts,
      errorCounts,
      productsWithImages,
      productsWithoutImages,
      createdProducts,
      createdProductsWithoutImages,
      createdDisplayReady,
      createdDisplayBroken,
      processedImagesTotal,
      products: goalInfo.map((item) => {
        const productId = String(item.id || item.product_id || "");
        const picture = pictureByProduct.get(productId);
        const processedPrimary = processedPrimaryImage(picture);
        const hasImageError = (item.errors || []).some((error) =>
          /image/i.test(String(error?.code || "")),
        );
        return {
          offerId: String(item.offer_id || ""),
          productId,
          moderateStatus: String(item?.statuses?.moderate_status || ""),
          statusName: String(item?.statuses?.status_name || ""),
          isCreated: item?.statuses?.is_created === true,
          primaryImage: primaryImage(item),
          imageCount: (Array.isArray(item.images) ? item.images.length : 0)
            + (primaryImage(item) ? 1 : 0),
          processedPrimaryImage: processedPrimary,
          processedImageCount: processedPictureImages(picture).length,
          displayReady: Boolean(
            processedPrimary && reachablePrimary.get(processedPrimary) && !hasImageError,
          ),
          pictureErrors: Array.isArray(picture?.errors) ? picture.errors : [],
          errors: (item.errors || []).map((error) => ({
            code: String(error.code || "unknown"),
            attributeId: error.attribute_id ?? null,
            message: String(error.message || error.description || ""),
          })),
        };
      }),
    },
    warehouses,
    limit,
    products: items.map((item) => ({
      offerId: String(item.offer_id || ""),
      productId: String(item.product_id || ""),
      hasFboStocks: Boolean(item.has_fbo_stocks),
      hasFbsStocks: Boolean(item.has_fbs_stocks),
      archived: Boolean(item.archived),
      isDiscounted: Boolean(item.is_discounted),
    })),
  };
}

try {
  const stores = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });
  const results = [];
  for (const store of stores) {
    try {
      results.push(await auditStore(store));
    } catch (error) {
      results.push({
        configId: store.id,
        name: store.name,
        clientId: store.clientId,
        active: store.isActive,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    storeCount: results.length,
    productTotal: results.reduce((sum, row) => sum + Number(row.total || 0), 0),
    stores: results,
  };
  await fs.mkdir(new URL("../storage/", import.meta.url), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    generatedAt: payload.generatedAt,
    storeCount: payload.storeCount,
    productTotal: payload.productTotal,
    stores: results.map(({ products, limit, ...row }) => ({
      ...row,
      limit: limit?.result || limit,
      sampleOfferIds: (products || []).slice(0, 3).map((item) => item.offerId),
    })),
    outputPath,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
