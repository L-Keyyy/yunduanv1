#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { chooseGlobalKeepers } from "./lib/ozon-global-dedupe.mjs";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    prefix: "RR4X-",
    plan: "storage/ozon-500-round-robin-plan.json",
    audit: "storage/ozon-global-dedupe-audit.json",
    execute: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--execute") args.execute = true;
    else if (token === "--prefix") args.prefix = String(argv[++index] || "");
    else if (token === "--plan") args.plan = String(argv[++index] || "");
    else if (token === "--audit") args.audit = String(argv[++index] || "");
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.prefix) throw new Error("商品前缀为空");
  return args;
}

function decrypt(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || "").split(":");
  const key = crypto.createHash("sha256")
    .update(process.env.APP_SECRET || "replace-with-your-own-long-secret")
    .digest();
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

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function sourceSku(offerId) {
  return String(offerId || "").match(/(\d{6,})$/)?.[1] || "";
}

function supplierOfferId(value) {
  return String(value || "").match(/(?:offerId=|offer\/)(\d{5,30})/i)?.[1] || "";
}

async function sellerRequest(store, endpoint, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${store.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
        method: "POST",
        headers: {
          "Client-Id": store.clientId,
          "Api-Key": store.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (response.ok) return payload;
      const error = new Error(`${endpoint} ${response.status}: ${text}`);
      error.status = response.status;
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (status >= 400 && status < 500 && status !== 429) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
  }
  throw lastError || new Error(`${endpoint} 请求失败`);
}

async function listProducts(store, prefix) {
  const rows = [];
  let lastId = "";
  do {
    const payload = await sellerRequest(store, "/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    });
    const result = payload?.result || payload || {};
    const page = Array.isArray(result.items) ? result.items : [];
    rows.push(...page.filter((row) => String(row.offer_id || "").startsWith(prefix)));
    const next = String(result.last_id || "");
    if (!page.length || !next || next === lastId) break;
    lastId = next;
  } while (true);
  return rows;
}

async function productInfo(store, offerIds) {
  const rows = [];
  for (const batch of chunks(offerIds, 100)) {
    const payload = await sellerRequest(store, "/v3/product/info/list", {
      offer_id: batch,
    });
    rows.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return rows;
}

function activeWarehouses(payload) {
  const values = Array.isArray(payload?.result)
    ? payload.result
    : payload?.result?.warehouses
      || payload?.result?.items
      || payload?.warehouses
      || payload?.items
      || [];
  return values.filter((warehouse) =>
    ["created", "active", "working", "enabled", ""].includes(
      String(warehouse.status || "").toLowerCase(),
    ),
  );
}

async function scanRows(stores, prefix, supplierBySku) {
  const rows = [];
  for (const store of stores) {
    const listed = await listProducts(store, prefix);
    const info = await productInfo(
      store,
      listed.map((row) => String(row.offer_id || "")).filter(Boolean),
    );
    const infoByOffer = new Map(info.map((row) => [String(row.offer_id || ""), row]));
    for (const listedRow of listed) {
      const offerId = String(listedRow.offer_id || "");
      const item = infoByOffer.get(offerId) || {};
      const sku = sourceSku(offerId);
      const supplier = supplierBySku.get(sku) || "";
      const modelId = String(item?.model_info?.model_id || "");
      const identityKey = supplier
        ? `supplier:${supplier}`
        : modelId
          ? `model:${modelId}`
          : sku
            ? `source:${sku}`
            : "";
      rows.push({
        identityKey,
        supplierOfferId: supplier || null,
        sourceSku: sku,
        modelId: modelId || null,
        storeId: store.id,
        storeName: store.name,
        offerId,
        productId: String(listedRow.product_id || item.id || ""),
        name: String(item.name || ""),
        isArchived: item.is_archived === true || listedRow.archived === true,
        isCreated: item?.statuses?.is_created === true,
        imageCount: [
          ...(Array.isArray(item.primary_image) ? item.primary_image : []),
          ...(Array.isArray(item.images) ? item.images : []),
        ].filter(Boolean).length,
        errorCount: Array.isArray(item.errors) ? item.errors.length : 0,
        errors: (Array.isArray(item.errors) ? item.errors : []).map((error) =>
          String(error?.code || "")
        ).filter(Boolean),
      });
    }
  }
  return rows;
}

async function zeroStocksAndArchive(store, cards) {
  const warehousePayload = await sellerRequest(store, "/v2/warehouse/list", {});
  const warehouses = activeWarehouses(warehousePayload);
  const stockErrors = [];
  for (const warehouse of warehouses) {
    const warehouseId = Number(warehouse.warehouse_id || warehouse.id || 0);
    if (!warehouseId) continue;
    for (const batch of chunks(cards, 100)) {
      const payload = await sellerRequest(store, "/v2/products/stocks", {
        stocks: batch.map((card) => ({
          offer_id: card.offerId,
          stock: 0,
          warehouse_id: warehouseId,
        })),
      });
      stockErrors.push(
        ...(Array.isArray(payload?.result) ? payload.result : [])
          .filter((item) => !item.updated)
          .map((item) => ({ offerId: item.offer_id, errors: item.errors || [] })),
      );
    }
  }

  let archived = 0;
  const archiveErrors = [];
  for (const batch of chunks(cards, 100)) {
    try {
      const payload = await sellerRequest(store, "/v1/product/archive", {
        product_id: batch.map((card) => Number(card.productId)),
      });
      if (payload?.result === true) archived += batch.length;
      else archiveErrors.push({ offerIds: batch.map((card) => card.offerId), payload });
    } catch (error) {
      archiveErrors.push({
        offerIds: batch.map((card) => card.offerId),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { archived, stockErrors, archiveErrors };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [plan, records] = await Promise.all([
    fs.readFile(path.resolve(args.plan), "utf8").then(JSON.parse),
    prisma.ozonApiConfig.findMany(),
  ]);
  const supplierBySku = new Map(
    (Array.isArray(plan?.candidates) ? plan.candidates : []).map((candidate) => [
      String(candidate.sourceSku || ""),
      supplierOfferId(candidate.supplierUrl),
    ]),
  );
  const stores = records.map((record) => ({
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }));
  const storeById = new Map(stores.map((store) => [store.id, store]));
  const beforeRows = await scanRows(stores, args.prefix, supplierBySku);
  const planned = chooseGlobalKeepers(beforeRows);
  const execution = [];

  if (args.execute) {
    for (const storeId of new Set(planned.archive.map((row) => row.storeId))) {
      const cards = planned.archive.filter((row) => row.storeId === storeId);
      const store = storeById.get(storeId);
      if (!store) {
        execution.push({ storeId, requested: cards.length, archived: 0, error: "store-config-missing" });
        continue;
      }
      const result = await zeroStocksAndArchive(store, cards);
      execution.push({
        storeId,
        storeName: store.name,
        requested: cards.length,
        ...result,
      });
      process.stdout.write(`${store.name}: 重复卡 ${cards.length} 个，已归档 ${result.archived} 个\n`);
    }
  }

  const afterRows = args.execute
    ? await scanRows(stores, args.prefix, supplierBySku)
    : beforeRows;
  const remaining = chooseGlobalKeepers(afterRows);
  const report = {
    completedAt: new Date().toISOString(),
    execute: args.execute,
    prefix: args.prefix,
    scannedCards: beforeRows.length,
    activeCardsBefore: beforeRows.filter((row) => !row.isArchived).length,
    duplicateGroupsBefore: planned.duplicateGroups.length,
    duplicateCardsToRemove: planned.archive.length,
    archived: execution.reduce((sum, row) => sum + Number(row.archived || 0), 0),
    activeCardsAfter: afterRows.filter((row) => !row.isArchived).length,
    duplicateGroupsAfter: remaining.duplicateGroups.length,
    duplicateCardsRemaining: remaining.archive.length,
    storePriority: [
      "Ozon Seller API",
      "Ozon 店铺 2",
      "Ozon 店铺 3",
      "Ozon 店铺 4",
      "Ozon 店铺 5",
      "Ozon 店铺 6",
    ],
    keep: planned.keep,
    archive: planned.archive,
    duplicateGroups: planned.duplicateGroups,
    execution,
  };
  await writeJsonAtomic(path.resolve(args.audit), report);
  console.log(JSON.stringify({
    completedAt: report.completedAt,
    execute: report.execute,
    scannedCards: report.scannedCards,
    activeCardsBefore: report.activeCardsBefore,
    duplicateGroupsBefore: report.duplicateGroupsBefore,
    duplicateCardsToRemove: report.duplicateCardsToRemove,
    archived: report.archived,
    activeCardsAfter: report.activeCardsAfter,
    duplicateGroupsAfter: report.duplicateGroupsAfter,
    duplicateCardsRemaining: report.duplicateCardsRemaining,
    errors: execution.reduce(
      (sum, row) => sum + (row.stockErrors?.length || 0) + (row.archiveErrors?.length || 0),
      0,
    ),
    auditPath: path.resolve(args.audit),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

