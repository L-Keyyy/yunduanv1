#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import {
  buildPriceFloorRepair,
  isOldPriceCompliant,
  money,
} from "./lib/ozon-price-floor.mjs";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    prefix: "RR4X-",
    floor: 15,
    audit: "storage/ozon-rr4x-price-floor-audit.json",
    dryRun: false,
    verifyAttempts: 6,
    verifyDelayMs: 5_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--prefix") args.prefix = String(argv[++index] || "");
    else if (token === "--floor") args.floor = Number(argv[++index]);
    else if (token === "--audit") args.audit = String(argv[++index] || "");
    else if (token === "--verify-attempts") args.verifyAttempts = Number(argv[++index]);
    else if (token === "--verify-delay-ms") args.verifyDelayMs = Number(argv[++index]);
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.prefix) throw new Error("商品前缀为空");
  if (!(args.floor > 0)) throw new Error("价格下限必须大于 0");
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
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (status >= 400 && status < 500 && status !== 429) throw error;
    }
    await delay(attempt * 1_500);
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

function priceState(item) {
  return item?.price && typeof item.price === "object" ? item.price : {};
}

function verifiedRow(row, liveItem, floor) {
  const state = priceState(liveItem);
  const price = money(state.price);
  const minPrice = money(state.min_price);
  const oldPrice = money(state.old_price);
  const ok = price >= floor
    && minPrice >= floor
    && minPrice <= price
    && isOldPriceCompliant(price, oldPrice)
    && state.auto_action_enabled !== true;
  return {
    storeId: row.storeId,
    store: row.storeName,
    offerId: row.offerId,
    productId: row.productId,
    before: {
      price: row.repair.currentPrice,
      minPrice: row.repair.currentMinPrice,
      oldPrice: row.repair.currentOldPrice,
    },
    target: {
      price: row.repair.targetPrice,
      minPrice: row.repair.targetMinPrice,
      oldPrice: row.repair.targetOldPrice,
    },
    actual: { price, minPrice, oldPrice },
    reasons: row.repair.reasons,
    verified: ok,
  };
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
  const storeRuns = [];
  for (const store of stores) {
    const listed = await listProducts(store, args.prefix);
    const offerIds = listed.map((row) => String(row.offer_id || "")).filter(Boolean);
    const [info, prices] = await Promise.all([
      productInfo(store, offerIds),
      productPrices(store, offerIds),
    ]);
    const infoByOffer = new Map(info.map((row) => [String(row.offer_id || ""), row]));
    const priceByOffer = new Map(prices.map((row) => [String(row.offer_id || ""), row]));
    const rows = listed.map((listedRow) => {
      const offerId = String(listedRow.offer_id || "");
      const infoRow = infoByOffer.get(offerId);
      const errors = Array.isArray(infoRow?.errors) ? infoRow.errors : [];
      const hasDiscountError = errors.some((error) =>
        String(error?.code || "") === "discount_for_low_price_is_too_small",
      );
      const livePrice = priceByOffer.get(offerId);
      return {
        store,
        storeId: store.id,
        storeName: store.name,
        offerId,
        productId: String(listedRow.product_id || infoRow?.id || ""),
        repair: buildPriceFloorRepair(priceState(livePrice), {
          floor: args.floor,
          hasDiscountError,
        }),
      };
    });
    const selected = rows.filter((row) => row.repair.needsRepair);
    const submissions = [];
    if (!args.dryRun) {
      for (const batch of chunks(selected, 1000)) {
        submissions.push(await sellerRequest(store, "/v1/product/import/prices", {
          prices: batch.map((row) => ({
            offer_id: row.offerId,
            price: row.repair.targetPrice.toFixed(2),
            min_price: row.repair.targetMinPrice.toFixed(2),
            old_price: row.repair.targetOldPrice.toFixed(2),
            currency_code: "CNY",
            vat: "0",
            auto_action_enabled: "DISABLED",
            min_price_for_auto_actions_enabled: true,
          })),
        }));
      }
    }
    storeRuns.push({ store, listed: rows.length, selected, submissions });
    process.stdout.write(
      `${store.name}: RR4X ${rows.length} 个，价格/折扣修复 ${selected.length} 个${args.dryRun ? "（预演）" : "（已提交）"}\n`,
    );
  }

  if (!args.dryRun && storeRuns.some((run) => run.selected.length)) {
    await delay(args.verifyDelayMs);
  }

  let verifiedRows = [];
  for (let attempt = 1; attempt <= Math.max(1, args.verifyAttempts); attempt += 1) {
    verifiedRows = [];
    for (const run of storeRuns) {
      const live = await productPrices(
        run.store,
        run.selected.map((row) => row.offerId),
      );
      const byOffer = new Map(live.map((row) => [String(row.offer_id || ""), row]));
      verifiedRows.push(...run.selected.map((row) =>
        verifiedRow(row, byOffer.get(row.offerId), args.floor),
      ));
    }
    if (args.dryRun || verifiedRows.every((row) => row.verified)) break;
    if (attempt < args.verifyAttempts) await delay(args.verifyDelayMs);
  }

  const audit = {
    completedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    prefix: args.prefix,
    floor: args.floor,
    storeCount: stores.length,
    listed: storeRuns.reduce((sum, run) => sum + run.listed, 0),
    requested: storeRuns.reduce((sum, run) => sum + run.selected.length, 0),
    verified: verifiedRows.filter((row) => row.verified).length,
    pendingVerification: verifiedRows.filter((row) => !row.verified).length,
    before: {
      belowFloor: storeRuns.flatMap((run) => run.selected)
        .filter((row) => row.repair.currentPrice < args.floor).length,
      discountErrors: storeRuns.flatMap((run) => run.selected)
        .filter((row) => row.repair.reasons.includes("discount_validation_error")).length,
      minPriceBelowFloor: storeRuns.flatMap((run) => run.selected)
        .filter((row) => row.repair.currentMinPrice < args.floor).length,
    },
    stores: storeRuns.map((run) => {
      const rows = verifiedRows.filter((row) => row.storeId === run.store.id);
      return {
        storeId: run.store.id,
        store: run.store.name,
        listed: run.listed,
        requested: run.selected.length,
        verified: rows.filter((row) => row.verified).length,
        pendingVerification: rows.filter((row) => !row.verified).length,
      };
    }),
    rows: verifiedRows,
  };
  await writeJsonAtomic(auditPath, audit);
  console.log(JSON.stringify({
    completedAt: audit.completedAt,
    prefix: audit.prefix,
    floor: audit.floor,
    listed: audit.listed,
    requested: audit.requested,
    verified: audit.verified,
    pendingVerification: audit.pendingVerification,
    before: audit.before,
    stores: audit.stores,
    auditPath,
  }, null, 2));
  if (!args.dryRun && audit.pendingVerification > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
