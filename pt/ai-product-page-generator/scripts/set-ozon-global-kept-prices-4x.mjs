#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const appSecret = process.env.APP_SECRET || "replace-with-your-own-long-secret";
const planPath = process.argv[2] || "storage/ozon-500-round-robin-plan.json";
const dedupePath = process.argv[3] || "storage/ozon-global-dedupe-audit.json";
const outputPath = process.argv[4] || "storage/ozon-global-kept-price-4x-audit.json";

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

async function sellerRequest(store, endpoint, body) {
  const response = await fetch(`${store.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Client-Id": store.clientId,
      "Api-Key": store.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = { raw: responseText };
  }
  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function actualPrice(item) {
  return Number(item?.price?.price ?? item?.price ?? Number.NaN);
}

try {
  const [plan, dedupe, records] = await Promise.all([
    fs.readFile(planPath, "utf8").then(JSON.parse),
    fs.readFile(dedupePath, "utf8").then(JSON.parse),
    prisma.ozonApiConfig.findMany(),
  ]);
  const candidates = new Map(
    (plan.candidates || []).map((candidate) => [String(candidate.sourceSku), candidate]),
  );
  const stores = new Map(records.map((record) => [record.id, {
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }]));
  const rowsByStore = new Map();
  for (const kept of dedupe.keep || []) {
    const candidate = candidates.get(String(kept.sourceSku));
    const purchase = Number(candidate?.purchasePrice1688Cny || 0);
    const domesticFreight = Number(candidate?.domesticFreight1688Cny);
    if (!(purchase > 0) || !(domesticFreight >= 0)) continue;
    const price = Math.max(15.01, Number(((purchase + domesticFreight) * 4).toFixed(2)));
    const row = {
      ...kept,
      purchasePrice1688Cny: purchase,
      domesticFreight1688Cny: domesticFreight,
      priceCny: price,
      // Ozon 对 400 以下商品要求划线价至少高 20；多留 0.01 避免小数舍入。
      oldPriceCny: Number((price + 20.01).toFixed(2)),
    };
    const values = rowsByStore.get(kept.storeId) || [];
    values.push(row);
    rowsByStore.set(kept.storeId, values);
  }

  const results = [];
  for (const [storeId, rows] of rowsByStore) {
    const store = stores.get(storeId);
    if (!store) continue;
    const submissions = [];
    for (const batch of chunks(rows, 1000)) {
      const payload = await sellerRequest(store, "/v1/product/import/prices", {
        prices: batch.map((row) => ({
          offer_id: row.offerId,
          price: row.priceCny.toFixed(2),
          old_price: row.oldPriceCny.toFixed(2),
          min_price: "15.00",
          currency_code: "CNY",
          vat: "0",
          auto_action_enabled: "DISABLED",
          min_price_for_auto_actions_enabled: true,
        })),
      });
      submissions.push(payload);
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const verified = [];
    for (const batch of chunks(rows, 100)) {
      const payload = await sellerRequest(store, "/v5/product/info/prices", {
        cursor: "",
        filter: { offer_id: batch.map((row) => row.offerId), visibility: "ALL" },
        limit: 100,
      });
      const byOffer = new Map(
        (payload?.items || []).map((item) => [String(item.offer_id || ""), item]),
      );
      for (const row of batch) {
        const actual = actualPrice(byOffer.get(row.offerId));
        verified.push({
          ...row,
          actualPriceCny: Number.isFinite(actual) ? actual : null,
          multiplierVerified: Number.isFinite(actual)
            && Math.abs(actual - row.priceCny) <= 0.01,
        });
      }
    }
    results.push({
      storeId,
      store: store.name,
      requested: rows.length,
      verified: verified.filter((row) => row.multiplierVerified).length,
      rows: verified,
      submissions,
    });
  }

  const report = {
    completedAt: new Date().toISOString(),
    multiplier: 4,
    requested: results.reduce((sum, row) => sum + row.requested, 0),
    verified: results.reduce((sum, row) => sum + row.verified, 0),
    results,
  };
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    completedAt: report.completedAt,
    multiplier: report.multiplier,
    requested: report.requested,
    verified: report.verified,
    stores: results.map((row) => ({
      store: row.store,
      requested: row.requested,
      verified: row.verified,
    })),
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
