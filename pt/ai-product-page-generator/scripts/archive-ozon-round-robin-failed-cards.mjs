#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const reportPath = path.resolve(
  process.argv[2] || "storage/ozon-500-image-final-report.json",
);
const outputPath = path.resolve(
  process.argv[3] || "storage/ozon-500-failed-card-archive-audit.json",
);
const appSecret = process.env.APP_SECRET || "replace-with-your-own-long-secret";

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
  const payload = responseText ? JSON.parse(responseText) : null;
  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

try {
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const rows = Array.isArray(report.missingCards) ? report.missingCards : [];
  if (!rows.length) throw new Error("报告中没有待归档的失败商品卡");
  const records = await prisma.ozonApiConfig.findMany();
  const stores = new Map(records.map((record) => [record.name, {
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }]));
  const grouped = new Map();
  for (const row of rows) {
    if (!Array.isArray(row.errors) || !row.errors.length) continue;
    const values = grouped.get(row.store) || [];
    values.push(row);
    grouped.set(row.store, values);
  }
  const results = [];
  for (const [storeName, cards] of grouped) {
    const store = stores.get(storeName);
    if (!store) {
      results.push({ store: storeName, archived: 0, error: "店铺配置不存在" });
      continue;
    }
    const payload = await sellerRequest(store, "/v1/product/archive", {
      product_id: cards.map((card) => Number(card.productId)),
    });
    results.push({
      store: storeName,
      requested: cards.length,
      archived: payload?.result === true ? cards.length : 0,
      result: payload?.result,
      offerIds: cards.map((card) => card.offerId),
    });
  }
  const audit = {
    completedAt: new Date().toISOString(),
    requested: rows.length,
    archived: results.reduce((total, row) => total + row.archived, 0),
    results,
  };
  await fs.writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(audit, null, 2));
} finally {
  await prisma.$disconnect();
}
