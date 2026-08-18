#!/usr/bin/env node
/**
 * Copy researched Ozon cards by SKU across all configured stores.
 *
 * The runner is resumable and only counts offers that are visible through the
 * target store's Seller API.  It deliberately uses a dedicated offer prefix so
 * progress can be audited independently from older catalogue items.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith("--")) {
    args.set(key.slice(2), value && !value.startsWith("--") ? value : "true");
    if (value && !value.startsWith("--")) index += 1;
  }
}

const targetTotal = Math.max(1, Number(args.get("target") || 500));
const batchSize = Math.max(1, Math.min(25, Number(args.get("batch-size") || 10)));
const stockQuantity = Math.max(0, Number(args.get("stock") || 100));
const offerPrefix = String(args.get("offer-prefix") || "RR500-");
if (offerPrefix === "RR4X-" && args.get("allow-fast-copy") !== "true") {
  throw new Error(
    "RR4X 快速复制入口已停用；现有 RR4X 商品只允许运行豆包主图替换队列。",
  );
}
const avoidOfferPrefixes = String(args.get("avoid-offer-prefix") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const planPath = String(args.get("plan") || "storage/ozon-500-round-robin-plan.json");
const statePath = String(args.get("state") || "storage/ozon-500-round-robin-state.json");
const appSecret = process.env.APP_SECRET || "replace-with-your-own-long-secret";
const requestedStoreId = String(args.get("store-id") || "").trim();

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

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, payload) {
  await fs.mkdir(new URL("../storage/", import.meta.url), { recursive: true });
  await fs.writeFile(`${path}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(`${path}.tmp`, path);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sellerRequest(store, endpoint, body, timeoutMs = 60_000) {
  const response = await fetch(`${store.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Client-Id": store.clientId,
      "Api-Key": store.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
    error.status = response.status;
    error.headers = Object.fromEntries(response.headers.entries());
    throw error;
  }
  return payload;
}

async function listProducts(store) {
  const items = [];
  let lastId = "";
  do {
    const payload = await sellerRequest(store, "/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    });
    const result = payload?.result || payload || {};
    const page = Array.isArray(result.items) ? result.items : [];
    items.push(...page);
    const next = String(result.last_id || "");
    if (!page.length || !next || next === lastId) break;
    lastId = next;
  } while (true);
  return items;
}

async function createdProducts(store, products) {
  const createdOfferIds = new Set();
  const offerIds = products.map((item) => String(item.offer_id || "")).filter(Boolean);
  for (let index = 0; index < offerIds.length; index += 100) {
    const payload = await sellerRequest(store, "/v3/product/info/list", {
      offer_id: offerIds.slice(index, index + 100),
    });
    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
      if (item?.statuses?.is_created === true) {
        createdOfferIds.add(String(item.offer_id || ""));
      }
    }
  }
  return products.filter((item) => createdOfferIds.has(String(item.offer_id || "")));
}

async function getPrices(store, offerIds) {
  const items = [];
  for (let index = 0; index < offerIds.length; index += 100) {
    const batch = offerIds.slice(index, index + 100);
    const payload = await sellerRequest(store, "/v5/product/info/prices", {
      cursor: "",
      filter: { offer_id: batch, visibility: "ALL" },
      limit: 100,
    });
    items.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return items;
}

async function pollImport(store, taskId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payload = await sellerRequest(store, "/v1/product/import/info", {
      task_id: Number(taskId),
    });
    const items = Array.isArray(payload?.result?.items) ? payload.result.items : [];
    const terminal = items.length > 0 && items.every(
      (item) => item.status === "imported" || item.status === "failed",
    );
    if (terminal) return items;
    await delay(2000);
  }
  return [];
}

async function getWarehouse(store) {
  try {
    const payload = await sellerRequest(store, "/v2/warehouse/list", {});
    const result = Array.isArray(payload?.result)
      ? payload.result
      : payload?.result?.warehouses
        || payload?.result?.items
        || payload?.warehouses
        || payload?.items
        || [];
    const ready = result.find((warehouse) =>
      ["created", "active", "working", "enabled", ""].includes(
        String(warehouse.status || "").toLowerCase(),
      ),
    );
    return ready || null;
  } catch {
    return null;
  }
}

async function setStocks(store, successfulRows) {
  if (!successfulRows.length || stockQuantity < 1) return { updated: 0 };
  const warehouse = await getWarehouse(store);
  const warehouseId = Number(
    warehouse?.warehouse_id || warehouse?.warehouseId || warehouse?.id || 0,
  );
  if (!warehouseId) return { updated: 0, error: "no-active-warehouse" };
  let updated = 0;
  const errors = [];
  for (let index = 0; index < successfulRows.length; index += 100) {
    const batch = successfulRows.slice(index, index + 100);
    try {
      const payload = await sellerRequest(store, "/v2/products/stocks", {
        stocks: batch.map((row) => ({
          offer_id: row.offerId,
          stock: stockQuantity,
          warehouse_id: warehouseId,
        })),
      });
      const result = Array.isArray(payload?.result) ? payload.result : [];
      updated += result.filter((item) => Boolean(item.updated)).length;
      errors.push(...result.filter((item) => !item.updated));
    } catch (error) {
      errors.push({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    warehouseId: String(warehouseId),
    warehouseName: String(warehouse.name || warehouse.warehouse_name || ""),
    updated,
    errors: errors.slice(0, 20),
  };
}

function normalizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!/^https:\/\//i.test(url)) return "";
  return url.replace(/\/(?:c\d+|wc\d+)\//i, "/");
}

async function setPictures(store, products, candidateBySku) {
  const submitted = [];
  const errors = [];
  for (const product of products) {
    const offerId = String(product.offer_id || "");
    const sourceSku = offerId.match(/(\d{6,})$/)?.[1] || "";
    const imageUrl = normalizeImageUrl(candidateBySku.get(sourceSku)?.imageUrl);
    const productId = Number(product.product_id || product.id || 0);
    if (!imageUrl || !productId) {
      errors.push({ offerId, sourceSku, error: "missing-public-image-or-product-id" });
      continue;
    }
    try {
      await sellerRequest(store, "/v1/product/pictures/import", {
        product_id: productId,
        images: [imageUrl],
      }, 120_000);
      submitted.push({ offerId, productId: String(productId), imageUrl });
    } catch (error) {
      errors.push({ offerId, sourceSku, error: compactError(error) });
    }
  }
  return { submitted: submitted.length, rows: submitted, errors };
}

function storeTargets(stores, total) {
  const base = Math.floor(total / stores.length);
  const remainder = total % stores.length;
  return Object.fromEntries(stores.map((store, index) => [
    store.id,
    base + (index < remainder ? 1 : 0),
  ]));
}

function compactError(error) {
  return error instanceof Error ? error.message.slice(0, 2000) : String(error);
}

function hasPeriodicLimit(items) {
  return (items || []).some((item) =>
    (item.errors || []).some((error) => error?.code === "periodic_limit_exceeded"),
  );
}

try {
  const plan = await readJson(planPath, null);
  if (!plan || !Array.isArray(plan.candidates) || !plan.candidates.length) {
    throw new Error("候选计划为空");
  }
  const incompletePricing = plan.candidates.filter((candidate) =>
    !(Number(candidate.purchasePrice1688Cny) > 0)
    || !(Number(candidate.domesticFreight1688Cny) >= 0)
    || !(Number(candidate.priceCny) > 0)
  );
  if (incompletePricing.length) {
    throw new Error(`候选计划有 ${incompletePricing.length} 个商品缺少采购价或 1688 国内运费`);
  }
  const records = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "asc" }],
  });
  const stores = records.map((record) => ({
    id: record.id,
    name: record.name,
    clientId: record.clientId,
    baseUrl: record.baseUrl,
    apiKey: decrypt(record.apiKeyEncrypted),
  })).filter((store) =>
    store.clientId
    && store.apiKey
    && (!requestedStoreId || store.id === requestedStoreId),
  );
  if (!stores.length) throw new Error("没有可用的 Ozon 店铺配置");
  const minimumPerStorePool = Math.ceil(targetTotal / stores.length);
  if (plan.candidates.length < minimumPerStorePool) {
    throw new Error(
      `候选计划不足：每店至少需要 ${minimumPerStorePool}，当前 ${plan.candidates.length}`,
    );
  }

  const targets = storeTargets(stores, targetTotal);
  const state = await readJson(statePath, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    targetTotal,
    offerPrefix,
    status: "running",
    assignments: [],
    attempts: [],
    stores: {},
  });
  state.targetTotal = targetTotal;
  state.offerPrefix = offerPrefix;
  state.status = "running";
  state.updatedAt = new Date().toISOString();

  const actualByStore = {};
  const acceptedByStore = {};
  const usedSourceSkusByStore = Object.fromEntries(
    stores.map((store) => [store.id, new Set()]),
  );
  const globalUsedSourceSkus = new Set();
  const attemptedThisRun = new Set();
  for (const store of stores) {
    const products = await listProducts(store);
    const goalProductRows = products.filter((item) =>
      String(item.offer_id || "").startsWith(offerPrefix),
    );
    const goalProducts = await createdProducts(store, goalProductRows);
    actualByStore[store.id] = goalProducts;
    acceptedByStore[store.id] = new Set(
      goalProducts.map((item) => String(item.offer_id || "")),
    );
    for (const item of goalProducts) {
      const match = String(item.offer_id || "").match(/(\d{6,})$/);
      if (match) usedSourceSkusByStore[store.id].add(match[1]);
    }
    for (const item of products) {
      const offerId = String(item.offer_id || "");
      const globalMatch = offerId.match(/(\d{6,})$/);
      if (/^RR/i.test(offerId) && globalMatch) {
        globalUsedSourceSkus.add(globalMatch[1]);
      }
      if (!avoidOfferPrefixes.some((prefix) => String(item.offer_id || "").startsWith(prefix))) {
        continue;
      }
      const match = String(item.offer_id || "").match(/(\d{6,})$/);
      if (match) usedSourceSkusByStore[store.id].add(match[1]);
    }
    state.stores[store.id] = {
      name: store.name,
      target: targets[store.id],
      verified: goalProducts.length,
      totalCatalogueProducts: products.length,
      quotaReached: state.stores?.[store.id]?.quotaReached === true,
    };
  }
  for (const attempt of state.attempts || []) {
    const usedForStore = usedSourceSkusByStore[attempt.storeId];
    // Persist only confirmed imports.  A previous request failure, unmatched
    // SKU, or terminal failed item must remain available for a later retry;
    // otherwise a restart incorrectly consumes the entire candidate pool.
    const confirmedSourceSkus = new Set();
    for (const item of attempt.items || []) {
      if (item.status !== "imported") continue;
      const match = String(item.offer_id || "").match(/(\d{6,})$/);
      if (match) confirmedSourceSkus.add(match[1]);
    }
    for (const offerId of attempt.verifiedOffers || []) {
      const match = String(offerId || "").match(/(\d{6,})$/);
      if (match) confirmedSourceSkus.add(match[1]);
    }
    for (const sourceSku of confirmedSourceSkus) {
      if (usedForStore) usedForStore.add(sourceSku);
      globalUsedSourceSkus.add(sourceSku);
    }
    if (hasPeriodicLimit(attempt.items) && state.stores[attempt.storeId]) {
      state.stores[attempt.storeId].quotaReached = true;
      state.stores[attempt.storeId].quotaEvidence = {
        taskId: attempt.taskId || null,
        observedAt: attempt.finishedAt || attempt.startedAt || null,
        code: "periodic_limit_exceeded",
      };
    }
  }
  await writeJson(statePath, state);

  const availableUniqueCandidates = plan.candidates.filter(
    (candidate) => !globalUsedSourceSkus.has(String(candidate.sourceSku)),
  ).length;
  const stillNeeded = stores.reduce((sum, store) => {
    if (state.stores[store.id]?.quotaReached) return sum;
    return sum + Math.max(0, targets[store.id] - acceptedByStore[store.id].size);
  }, 0);
  if (availableUniqueCandidates < stillNeeded) {
    throw new Error(
      `全局唯一候选不足：还需 ${stillNeeded}，当前可用 ${availableUniqueCandidates}`,
    );
  }

  const candidateBySku = new Map(
    plan.candidates.map((candidate) => [String(candidate.sourceSku), candidate]),
  );

  const candidateIndexByStore = Object.fromEntries(
    stores.map((store, index) => [store.id, index * 17]),
  );
  let nextStoreIndex = 0;
  const storeIsComplete = (store) =>
    state.stores[store.id]?.quotaReached
    || acceptedByStore[store.id].size >= targets[store.id];
  while (!stores.every(storeIsComplete)) {
    let store = null;
    for (let offset = 0; offset < stores.length; offset += 1) {
      const candidateStore = stores[(nextStoreIndex + offset) % stores.length];
      if (!storeIsComplete(candidateStore)) {
        store = candidateStore;
        nextStoreIndex = (stores.indexOf(candidateStore) + 1) % stores.length;
        break;
      }
    }
    if (!store) break;
    const remaining = targets[store.id] - acceptedByStore[store.id].size;
    const selected = [];
    let scanned = 0;
    while (selected.length < Math.min(batchSize, remaining) && scanned < plan.candidates.length) {
      const cursor = candidateIndexByStore[store.id] % plan.candidates.length;
      const candidate = plan.candidates[cursor];
      candidateIndexByStore[store.id] += 1;
      scanned += 1;
      if (globalUsedSourceSkus.has(String(candidate.sourceSku))) continue;
      if (attemptedThisRun.has(String(candidate.sourceSku))) continue;
      if (usedSourceSkusByStore[store.id].has(String(candidate.sourceSku))) continue;
      usedSourceSkusByStore[store.id].add(String(candidate.sourceSku));
      globalUsedSourceSkus.add(String(candidate.sourceSku));
      attemptedThisRun.add(String(candidate.sourceSku));
      selected.push(candidate);
    }
    if (!selected.length) throw new Error("候选商品已用尽，目标尚未完成");

    const requestItems = selected.map((candidate) => ({
      sku: Number(candidate.sourceSku),
      offer_id: `${offerPrefix}${candidate.sourceSku}`.slice(0, 50),
      price: Number(candidate.priceCny).toFixed(2),
      old_price: Number(candidate.oldPriceCny).toFixed(2),
      currency_code: "CNY",
      vat: "0",
    }));
    const batchRecord = {
      startedAt: new Date().toISOString(),
      storeId: store.id,
      storeName: store.name,
      sourceSkus: selected.map((candidate) => String(candidate.sourceSku)),
      status: "submitting",
    };
    state.attempts.push(batchRecord);
    await writeJson(statePath, state);

    try {
      const response = await sellerRequest(store, "/v1/product/import-by-sku", {
        items: requestItems,
      });
      const taskId = response?.result?.task_id;
      const unmatched = new Set(
        (response?.result?.unmatched_sku_list || []).map((value) => String(value)),
      );
      batchRecord.taskId = taskId ? String(taskId) : null;
      batchRecord.unmatchedSourceSkus = [...unmatched];
      const infoItems = taskId ? await pollImport(store, taskId) : [];
      batchRecord.items = infoItems;
      const importedSourceSkus = new Set();
      for (const item of infoItems) {
        if (item.status === "imported" && String(item.offer_id || "").startsWith(offerPrefix)) {
          const match = String(item.offer_id || "").match(/(\d{6,})$/);
          if (match) importedSourceSkus.add(match[1]);
        }
      }
      if (hasPeriodicLimit(infoItems)) {
        state.stores[store.id].quotaReached = true;
        state.stores[store.id].quotaEvidence = {
          taskId: batchRecord.taskId,
          observedAt: new Date().toISOString(),
          code: "periodic_limit_exceeded",
        };
      }
      for (const candidate of selected) {
        const sourceSku = String(candidate.sourceSku);
        if (importedSourceSkus.has(sourceSku)) continue;
        usedSourceSkusByStore[store.id].delete(sourceSku);
        globalUsedSourceSkus.delete(sourceSku);
      }
      batchRecord.status = "polled";
      batchRecord.finishedAt = new Date().toISOString();
    } catch (error) {
      batchRecord.status = "request_failed";
      batchRecord.error = compactError(error);
      batchRecord.finishedAt = new Date().toISOString();
      for (const candidate of selected) {
        const sourceSku = String(candidate.sourceSku);
        usedSourceSkusByStore[store.id].delete(sourceSku);
        globalUsedSourceSkus.delete(sourceSku);
      }
      if (error?.status === 429) {
        state.status = "quota_paused";
        state.pauseReason = batchRecord.error;
        await writeJson(statePath, state);
        throw error;
      }
    }

    await delay(2500);
    const refreshed = await listProducts(store);
    const goalProductRows = refreshed.filter((item) =>
      String(item.offer_id || "").startsWith(offerPrefix),
    );
    const goalProducts = await createdProducts(store, goalProductRows);
    const previousOffers = new Set(
      actualByStore[store.id].map((item) => String(item.offer_id || "")),
    );
    const newlyVerified = goalProducts.filter((item) =>
      !previousOffers.has(String(item.offer_id || "")),
    );
    actualByStore[store.id] = goalProducts;
    acceptedByStore[store.id] = new Set(
      goalProducts.map((item) => String(item.offer_id || "")),
    );
    batchRecord.verifiedOffers = newlyVerified.map((item) => String(item.offer_id || ""));
    batchRecord.pictures = await setPictures(store, newlyVerified, candidateBySku);
    batchRecord.stock = await setStocks(
      store,
      newlyVerified.map((item) => ({ offerId: String(item.offer_id || "") })),
    );
    state.stores[store.id].verified = goalProducts.length;
    state.stores[store.id].accepted = acceptedByStore[store.id].size;
    state.updatedAt = new Date().toISOString();
    await writeJson(statePath, state);
    console.log(JSON.stringify({
      store: store.name,
      target: targets[store.id],
      verified: goalProducts.length,
      accepted: acceptedByStore[store.id].size,
      newlyVerified: newlyVerified.length,
      overallVerified: Object.values(actualByStore).reduce((sum, rows) => sum + rows.length, 0),
      overallTarget: targetTotal,
    }));
  }

  // Seller API product-list indexing is eventually consistent.  Give every
  // imported task a bounded visibility window before writing the final audit.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let changed = false;
    for (const store of stores) {
      const refreshed = await listProducts(store);
      const goalProductRows = refreshed.filter((item) =>
        String(item.offer_id || "").startsWith(offerPrefix),
      );
      const goalProducts = await createdProducts(store, goalProductRows);
      if (goalProducts.length !== actualByStore[store.id].length) changed = true;
      actualByStore[store.id] = goalProducts;
      state.stores[store.id].verified = goalProducts.length;
    }
    const visible = Object.values(actualByStore).reduce((sum, rows) => sum + rows.length, 0);
    if (visible >= targetTotal || !changed && attempt >= 5) break;
    await delay(5000);
  }
  const verifiedTotal = Object.values(actualByStore).reduce((sum, rows) => sum + rows.length, 0);
  const sourceSkuStores = new Map();
  for (const store of stores) {
    for (const item of actualByStore[store.id]) {
      const sourceSku = String(item.offer_id || "").match(/(\d{6,})$/)?.[1] || "";
      if (!sourceSku) continue;
      const rows = sourceSkuStores.get(sourceSku) || [];
      rows.push({ storeId: store.id, storeName: store.name, offerId: String(item.offer_id || "") });
      sourceSkuStores.set(sourceSku, rows);
    }
  }
  const crossStoreDuplicates = [...sourceSkuStores.entries()]
    .filter(([, rows]) => new Set(rows.map((row) => row.storeId)).size > 1)
    .map(([sourceSku, rows]) => ({ sourceSku, rows }));
  const expectedPriceBySku = new Map(
    plan.candidates.map((candidate) => [
      String(candidate.sourceSku),
      {
        purchase: Number(candidate.purchasePrice1688Cny),
        domesticFreight: Number(candidate.domesticFreight1688Cny),
        price: Number(candidate.priceCny),
      },
    ]),
  );
  const priceRows = [];
  for (const store of stores) {
    const offerIds = actualByStore[store.id].map((item) => String(item.offer_id || ""));
    const prices = await getPrices(store, offerIds);
    const priceByOffer = new Map(prices.map((item) => [String(item.offer_id || ""), item]));
    for (const offerId of offerIds) {
      const match = offerId.match(/(\d{6,})$/);
      const sourceSku = match?.[1] || "";
      const expectedEntry = expectedPriceBySku.get(sourceSku);
      const expected = Number(expectedEntry?.price || 0);
      const item = priceByOffer.get(offerId);
      const actual = Number(item?.price?.price ?? NaN);
      priceRows.push({
        storeId: store.id,
        storeName: store.name,
        offerId,
        sourceSku,
        purchasePrice1688Cny: expectedEntry
          ? Number(expectedEntry.purchase.toFixed(4))
          : null,
        domesticFreight1688Cny: expectedEntry
          ? Number(expectedEntry.domesticFreight.toFixed(4))
          : null,
        expectedPriceCny: expected || null,
        actualPriceCny: Number.isFinite(actual) ? actual : null,
        multiplierVerified: Boolean(
          expected && Number.isFinite(actual) && Math.abs(actual - expected) <= 0.01
        ),
      });
    }
  }
  const priceMismatchCount = priceRows.filter((row) => !row.multiplierVerified).length;
  const stockAudit = {};
  for (const store of stores) {
    stockAudit[store.id] = {
      storeName: store.name,
      requested: actualByStore[store.id].length,
      ...(await setStocks(
        store,
        actualByStore[store.id].map((item) => ({
          offerId: String(item.offer_id || ""),
        })),
      )),
    };
  }
  const quotaReachedForAllStores = stores.every((store) =>
    state.stores[store.id]?.quotaReached
    || actualByStore[store.id].length >= targets[store.id],
  );
  state.status = quotaReachedForAllStores
    && priceMismatchCount === 0
    && crossStoreDuplicates.length === 0
    ? "completed"
    : "incomplete";
  state.verifiedTotal = verifiedTotal;
  state.quotaAudit = {
    allStoresReachedDailyLimit: quotaReachedForAllStores,
    stores: Object.fromEntries(stores.map((store) => [store.name, {
      target: targets[store.id],
      visible: actualByStore[store.id].length,
      periodicLimitReached: state.stores[store.id]?.quotaReached === true,
      evidence: state.stores[store.id]?.quotaEvidence || null,
    }])),
  };
  state.uniquenessAudit = {
    checked: verifiedTotal,
    uniqueSourceSkus: sourceSkuStores.size,
    crossStoreDuplicateCount: crossStoreDuplicates.length,
    duplicates: crossStoreDuplicates,
  };
  state.priceAudit = {
    checked: priceRows.length,
    multiplier: 4.0,
    verified: priceRows.length - priceMismatchCount,
    mismatch: priceMismatchCount,
    rows: priceRows,
  };
  state.stockAudit = stockAudit;
  state.completedAt = new Date().toISOString();
  state.distribution = Object.fromEntries(stores.map((store) => [
    store.name,
    actualByStore[store.id].length,
  ]));
  await writeJson(statePath, state);
  console.log(JSON.stringify({
    status: state.status,
    verifiedTotal,
    targetTotal,
    allStoresReachedDailyLimit: quotaReachedForAllStores,
    crossStoreDuplicateCount: crossStoreDuplicates.length,
    priceMismatchCount,
    distribution: state.distribution,
    statePath,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
