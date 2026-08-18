#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    floor: 15,
    target: 15.01,
    audit: "storage/ozon-all-stores-price-above-15-audit.json",
    dryRun: false,
    verifyAttempts: 10,
    verifyDelayMs: 5_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--floor") args.floor = Number(argv[++index]);
    else if (token === "--target") args.target = Number(argv[++index]);
    else if (token === "--audit") args.audit = String(argv[++index] || "");
    else if (token === "--verify-attempts") args.verifyAttempts = Number(argv[++index]);
    else if (token === "--verify-delay-ms") args.verifyDelayMs = Number(argv[++index]);
    else throw new Error(`未知参数：${token}`);
  }
  if (!(args.floor > 0) || !(args.target > args.floor)) {
    throw new Error("目标售价必须严格高于价格下限");
  }
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function priceState(item) {
  return item?.price && typeof item.price === "object" ? item.price : {};
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

async function listAllProducts(store) {
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
    rows.push(...page);
    const next = String(result.last_id || "");
    if (!page.length || !next || next === lastId) break;
    lastId = next;
  } while (true);
  return rows;
}

async function productPrices(store, offerIds) {
  const rows = [];
  for (const batch of chunks(offerIds, 100)) {
    if (!batch.length) continue;
    const payload = await sellerRequest(store, "/v5/product/info/prices", {
      cursor: "",
      filter: { offer_id: batch, visibility: "ALL" },
      limit: 100,
    });
    rows.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return rows;
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
  const runs = [];

  for (const store of stores) {
    try {
      const listed = await listAllProducts(store);
      const offerIds = listed.map((row) => String(row.offer_id || "")).filter(Boolean);
      const prices = await productPrices(store, offerIds);
      const targets = prices.flatMap((item) => {
        const state = priceState(item);
        const currentPrice = money(state.price);
        if (!(currentPrice > 0 && currentPrice < args.floor)) return [];
        const currentOldPrice = money(state.old_price);
        return [{
          offerId: String(item.offer_id || ""),
          productId: String(item.product_id || ""),
          beforePrice: currentPrice,
          beforeMinPrice: money(state.min_price),
          beforeOldPrice: currentOldPrice,
          targetPrice: args.target,
          targetMinPrice: args.target,
          targetOldPrice: 0,
        }];
      });
      const submissions = [];
      if (!args.dryRun) {
        for (const batch of chunks(targets, 1000)) {
          submissions.push(await sellerRequest(store, "/v1/product/import/prices", {
            prices: batch.map((row) => ({
              offer_id: row.offerId,
              price: row.targetPrice.toFixed(2),
              min_price: row.targetMinPrice.toFixed(2),
              old_price: row.targetOldPrice.toFixed(2),
              currency_code: "CNY",
              vat: "0",
              auto_action_enabled: "DISABLED",
              price_strategy_enabled: "DISABLED",
              min_price_for_auto_actions_enabled: true,
            })),
          }));
        }
      }
      runs.push({
        store,
        listed: listed.length,
        priced: prices.length,
        targets,
        submissions,
        error: null,
      });
      const rejected = submissions.flatMap((payload) => payload?.result || [])
        .filter((result) => !result.updated);
      process.stdout.write(
        `${store.name}: 扫描 ${listed.length} 个商品，低于 ${args.floor.toFixed(2)} 元 ${targets.length} 个${args.dryRun ? "（预演）" : `（已提交，接口拒绝 ${rejected.length} 个）`}\n`,
      );
    } catch (error) {
      runs.push({
        store,
        listed: 0,
        priced: 0,
        targets: [],
        submissions: [],
        error: error instanceof Error ? error.message : String(error),
      });
      process.stderr.write(`${store.name}: 扫描失败：${runs.at(-1).error}\n`);
    }
  }

  if (!args.dryRun && runs.some((run) => run.targets.length)) {
    await delay(args.verifyDelayMs);
  }

  const verifiedRows = [];
  for (const run of runs) {
    if (run.error || !run.targets.length) continue;
    let actualByOffer = new Map();
    let verificationError = null;
    for (let attempt = 1; attempt <= Math.max(1, args.verifyAttempts); attempt += 1) {
      try {
        const actual = await productPrices(
          run.store,
          run.targets.map((row) => row.offerId),
        );
        actualByOffer = new Map(actual.map((item) => [String(item.offer_id || ""), item]));
        verificationError = null;
        const allReady = run.targets.every((row) =>
          money(priceState(actualByOffer.get(row.offerId)).price) > args.floor
        );
        if (args.dryRun || allReady) break;
      } catch (error) {
        verificationError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < args.verifyAttempts) await delay(args.verifyDelayMs);
    }
    for (const row of run.targets) {
      const state = priceState(actualByOffer.get(row.offerId));
      const actualPrice = money(state.price);
      verifiedRows.push({
        storeId: run.store.id,
        store: run.store.name,
        ...row,
        actualPrice,
        actualMinPrice: money(state.min_price),
        actualOldPrice: money(state.old_price),
        verified: !args.dryRun && actualPrice > args.floor,
        verificationError,
      });
    }
  }

  const report = {
    completedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    floor: args.floor,
    targetPrice: args.target,
    storeCount: stores.length,
    scanned: runs.reduce((sum, run) => sum + run.listed, 0),
    priceRowsFound: runs.reduce((sum, run) => sum + run.priced, 0),
    requested: runs.reduce((sum, run) => sum + run.targets.length, 0),
    verified: verifiedRows.filter((row) => row.verified).length,
    pendingVerification: args.dryRun
      ? 0
      : verifiedRows.filter((row) => !row.verified).length,
    storeErrors: runs.filter((run) => run.error).length,
    stores: runs.map((run) => {
      const rows = verifiedRows.filter((row) => row.storeId === run.store.id);
      return {
        storeId: run.store.id,
        store: run.store.name,
        listed: run.listed,
        priceRowsFound: run.priced,
        requested: run.targets.length,
        verified: rows.filter((row) => row.verified).length,
        pendingVerification: args.dryRun ? 0 : rows.filter((row) => !row.verified).length,
        rejected: run.submissions.flatMap((payload) => payload?.result || [])
          .filter((result) => !result.updated),
        error: run.error,
      };
    }),
    rows: verifiedRows,
  };
  await writeJsonAtomic(auditPath, report);
  console.log(JSON.stringify({
    completedAt: report.completedAt,
    floor: report.floor,
    targetPrice: report.targetPrice,
    scanned: report.scanned,
    priceRowsFound: report.priceRowsFound,
    requested: report.requested,
    verified: report.verified,
    pendingVerification: report.pendingVerification,
    storeErrors: report.storeErrors,
    stores: report.stores,
    auditPath,
  }, null, 2));
  if (!args.dryRun && (report.pendingVerification || report.storeErrors)) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
