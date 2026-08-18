#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { buildPriceFloorRepair } from "./lib/ozon-price-floor.mjs";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    prefix: "RR4X-",
    floor: 15,
    batchSize: 10,
    audit: "storage/ozon-rr4x-failed-import-retry-audit.json",
    dryRun: false,
    includeCreatedImageErrors: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--include-created-image-errors") args.includeCreatedImageErrors = true;
    else if (token === "--prefix") args.prefix = String(argv[++index] || "");
    else if (token === "--floor") args.floor = Number(argv[++index]);
    else if (token === "--batch-size") args.batchSize = Number(argv[++index]);
    else if (token === "--audit") args.audit = String(argv[++index] || "");
    else throw new Error(`未知参数：${token}`);
  }
  args.batchSize = Math.max(1, Math.min(25, args.batchSize));
  return args;
}

function decrypt(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || "").split(":");
  const key = crypto
    .createHash("sha256")
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
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sellerRequest(store, endpoint, body, timeoutMs = 60_000) {
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
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (response.ok) return payload;
      const error = new Error(`${endpoint} ${response.status}: ${text}`);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get("item-retry-after") || 0);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
      const waitMs = response.status === 429 && error.retryAfter > 0
        ? Math.min(error.retryAfter * 60_000, 10 * 60_000)
        : attempt * 1_500;
      await delay(waitMs);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (status >= 400 && status < 500 && status !== 429) throw error;
      await delay(attempt * 1_500);
    }
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

async function productPrices(store, offerIds) {
  const rows = [];
  for (const batch of chunks(offerIds, 100)) {
    const payload = await sellerRequest(store, "/v5/product/info/prices", {
      cursor: "",
      filter: { offer_id: batch, visibility: "ALL" },
      limit: 100,
    });
    rows.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return rows;
}

async function pollImport(store, taskId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payload = await sellerRequest(store, "/v1/product/import/info", {
      task_id: Number(taskId),
    });
    const items = Array.isArray(payload?.result?.items) ? payload.result.items : [];
    if (items.length && items.every((item) =>
      item.status === "imported" || item.status === "failed"
    )) return items;
    await delay(2_000);
  }
  return [];
}

function sourceSku(offerId) {
  return String(offerId || "").match(/(\d{6,})$/)?.[1] || "";
}

function errorCodes(item) {
  return (Array.isArray(item?.errors) ? item.errors : [])
    .map((error) => String(error?.code || ""))
    .filter(Boolean);
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auditPath = path.resolve(args.audit);
  const records = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "asc" }, { id: "asc" }],
  });
  const stores = records.map((record) => ({
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }));
  const results = [];
  for (const store of stores) {
    const listed = await listProducts(store, args.prefix);
    const offerIds = listed.map((row) => String(row.offer_id || "")).filter(Boolean);
    const [info, prices] = await Promise.all([
      productInfo(store, offerIds),
      productPrices(store, offerIds),
    ]);
    const infoByOffer = new Map(info.map((row) => [String(row.offer_id || ""), row]));
    const priceByOffer = new Map(prices.map((row) => [String(row.offer_id || ""), row]));
    const targets = listed.flatMap((row) => {
      const offerId = String(row.offer_id || "");
      const sku = sourceSku(offerId);
      const infoRow = infoByOffer.get(offerId);
      const codes = errorCodes(infoRow);
      if (!sku) return [];
      if (
        infoRow?.statuses?.is_created === true
        && !args.includeCreatedImageErrors
      ) return [];
      if (
        !codes.includes("image_not_upload")
        && !codes.includes("image_absent_with_shipment")
        && !codes.includes("discount_for_low_price_is_too_small")
      ) {
        return [];
      }
      const state = priceByOffer.get(offerId)?.price || {};
      const repair = buildPriceFloorRepair(state, {
        floor: args.floor,
        hasDiscountError: codes.includes("discount_for_low_price_is_too_small"),
      });
      return [{
        offerId,
        sourceSku: sku,
        productId: String(row.product_id || infoRow?.id || ""),
        beforeErrors: codes,
        price: repair.targetPrice,
        oldPrice: repair.targetOldPrice || repair.targetPrice + 20.01,
      }];
    });
    const batches = [];
    for (const batch of chunks(targets, args.batchSize)) {
      if (args.dryRun) {
        batches.push({ dryRun: true, offerIds: batch.map((row) => row.offerId), items: [] });
        continue;
      }
      const response = await sellerRequest(store, "/v1/product/import-by-sku", {
        items: batch.map((row) => ({
          sku: Number(row.sourceSku),
          offer_id: row.offerId,
          price: row.price.toFixed(2),
          old_price: row.oldPrice.toFixed(2),
          currency_code: "CNY",
          vat: "0",
        })),
      });
      const taskId = response?.result?.task_id;
      const items = taskId ? await pollImport(store, taskId) : [];
      batches.push({
        taskId: taskId ? String(taskId) : null,
        unmatchedSkuList: response?.result?.unmatched_sku_list || [],
        offerIds: batch.map((row) => row.offerId),
        items,
      });
      process.stdout.write(
        `${store.name}: 已重试 ${batch.length} 个失败卡，成功 ${items.filter((item) => item.status === "imported" && !(item.errors || []).length).length} 个\n`,
      );
      await delay(1_000);
    }
    const terminalItems = batches.flatMap((batch) => batch.items || []);
    results.push({
      storeId: store.id,
      store: store.name,
      listed: listed.length,
      requested: targets.length,
      imported: terminalItems.filter((item) =>
        item.status === "imported" && !(item.errors || []).length
      ).length,
      failed: terminalItems.filter((item) =>
        item.status === "failed" || (item.errors || []).length
      ).length,
      targets,
      batches,
    });
  }
  const audit = {
    completedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    prefix: args.prefix,
    floor: args.floor,
    requested: results.reduce((sum, row) => sum + row.requested, 0),
    imported: results.reduce((sum, row) => sum + row.imported, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0),
    stores: results,
  };
  await writeJsonAtomic(auditPath, audit);
  console.log(JSON.stringify({
    completedAt: audit.completedAt,
    requested: audit.requested,
    imported: audit.imported,
    failed: audit.failed,
    stores: results.map((row) => ({
      store: row.store,
      requested: row.requested,
      imported: row.imported,
      failed: row.failed,
    })),
    auditPath,
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
