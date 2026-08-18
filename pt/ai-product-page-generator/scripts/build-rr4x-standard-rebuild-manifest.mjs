#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const planPath = path.resolve(process.argv[2] || "storage/ozon-500-round-robin-plan.json");
const outputPath = path.resolve(
  process.argv[3] || "storage/rr4x-standard-rebuild/sources.json",
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
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
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

function sourceSku(offerId) {
  return String(offerId || "").match(/(\d{6,})$/)?.[1] || "";
}

function offer1688(value) {
  return String(value || "").match(/(?:offerId=|offer\/)(\d{5,30})/i)?.[1] || "";
}

try {
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  const candidates = new Map(
    (plan.candidates || []).map((candidate) => [String(candidate.sourceSku), candidate]),
  );
  const records = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "asc" }],
  });
  const rawRows = [];
  for (const record of records) {
    const store = { ...record, apiKey: decrypt(record.apiKeyEncrypted) };
    const products = await listProducts(store);
    for (const product of products) {
      const oldOfferId = String(product.offer_id || "");
      if (!oldOfferId.startsWith("RR4X-")) continue;
      const ozonSourceSku = sourceSku(oldOfferId);
      const candidate = candidates.get(ozonSourceSku);
      const supplierOfferId = offer1688(candidate?.supplierUrl);
      if (!candidate || !supplierOfferId) continue;
      rawRows.push({
        supplierOfferId,
        sourceUrl: `https://m.1688.com/offer/${supplierOfferId}.html`,
        supplierUrl: candidate.supplierUrl,
        purchasePrice1688Cny: Number(candidate.purchasePrice1688Cny || 0),
        domesticFreight1688Cny: Number(candidate.domesticFreight1688Cny),
        salePriceCny: Number(candidate.priceCny || 0),
        pricingRule: "CNY_X4",
        sourceOzonSku: ozonSourceSku,
        sourceOzonTitle: candidate.title || "",
        sourceImageUrl: candidate.imageUrl || "",
        previousOfferId: oldOfferId,
        previousStoreId: store.id,
        previousStoreName: store.name,
      });
    }
  }

  const uniqueBySupplierOffer = new Map();
  for (const row of rawRows) {
    if (!uniqueBySupplierOffer.has(row.supplierOfferId)) {
      uniqueBySupplierOffer.set(row.supplierOfferId, {
        ...row,
        previousPlacements: [{
          storeId: row.previousStoreId,
          storeName: row.previousStoreName,
          offerId: row.previousOfferId,
          sourceOzonSku: row.sourceOzonSku,
        }],
      });
      continue;
    }
    uniqueBySupplierOffer.get(row.supplierOfferId).previousPlacements.push({
      storeId: row.previousStoreId,
      storeName: row.previousStoreName,
      offerId: row.previousOfferId,
      sourceOzonSku: row.sourceOzonSku,
    });
  }

  const sources = [...uniqueBySupplierOffer.values()];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    mode: "standard-full-workflow",
    fastCopyDisabled: true,
    pricingRule: "1688_CNY_X4",
    rawPlacements: rawRows.length,
    unique1688Products: sources.length,
    removedCrossStoreSourceDuplicates: rawRows.length - sources.length,
    sources,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    outputPath,
    rawPlacements: rawRows.length,
    unique1688Products: sources.length,
    removedCrossStoreSourceDuplicates: rawRows.length - sources.length,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
