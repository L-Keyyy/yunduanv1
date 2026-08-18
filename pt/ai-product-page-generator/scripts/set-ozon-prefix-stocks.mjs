#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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

const offerPrefix = String(args.get("offer-prefix") || "RR4X-");
const quantity = Math.max(0, Number(args.get("quantity") || 100));
const outputPath = path.resolve(
  String(args.get("output") || "storage/ozon-prefix-stock-audit.json"),
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
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function listPrefixOffers(store) {
  const offers = [];
  let lastId = "";
  do {
    const payload = await sellerRequest(store, "/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    });
    const result = payload?.result || payload || {};
    const page = Array.isArray(result.items) ? result.items : [];
    for (const item of page) {
      const offerId = String(item.offer_id || "");
      if (offerId.startsWith(offerPrefix)) offers.push(offerId);
    }
    const next = String(result.last_id || "");
    if (!page.length || !next || next === lastId) break;
    lastId = next;
  } while (true);
  return [...new Set(offers)];
}

function warehouseRows(payload) {
  return Array.isArray(payload?.result)
    ? payload.result
    : payload?.result?.warehouses
      || payload?.result?.items
      || payload?.warehouses
      || payload?.items
      || [];
}

function activeWarehouse(payload) {
  return warehouseRows(payload).find((warehouse) =>
    ["created", "active", "working", "enabled", ""].includes(
      String(warehouse.status || "").toLowerCase(),
    ),
  );
}

function warehouseId(warehouse) {
  return Number(warehouse?.warehouse_id || warehouse?.warehouseId || warehouse?.id || 0);
}

try {
  const records = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "asc" }],
  });
  const results = [];
  for (const record of records) {
    const store = { ...record, apiKey: decrypt(record.apiKeyEncrypted) };
    const offerIds = await listPrefixOffers(store);
    const warehousePayload = await sellerRequest(store, "/v2/warehouse/list", {});
    const warehouse = activeWarehouse(warehousePayload);
    const id = warehouseId(warehouse);
    if (!id) {
      results.push({
        storeId: store.id,
        store: store.name,
        requested: offerIds.length,
        updated: 0,
        verifiedAtQuantity: 0,
        error: "no-active-warehouse",
      });
      continue;
    }

    const updateRows = [];
    for (const batch of chunks(offerIds, 100)) {
      const payload = await sellerRequest(store, "/v2/products/stocks", {
        stocks: batch.map((offerId) => ({
          offer_id: offerId,
          stock: quantity,
          warehouse_id: id,
        })),
      });
      updateRows.push(...(Array.isArray(payload?.result) ? payload.result : []));
    }

    const stockRows = [];
    for (const batch of chunks(offerIds, 1000)) {
      const payload = await sellerRequest(store, "/v4/product/info/stocks", {
        cursor: "",
        filter: { offer_id: batch, visibility: "ALL" },
        limit: 1000,
      });
      stockRows.push(...(Array.isArray(payload?.items) ? payload.items : []));
    }
    const verifiedOffers = new Set(
      stockRows
        .filter((item) => (item.stocks || []).some((stock) =>
          ["fbs", "rfbs"].includes(String(stock.type || "").toLowerCase())
          && Number(stock.present) === quantity,
        ))
        .map((item) => String(item.offer_id || "")),
    );
    const errors = updateRows
      .filter((item) => !item.updated)
      .map((item) => ({
        offerId: String(item.offer_id || ""),
        productId: String(item.product_id || ""),
        errors: item.errors || [],
      }));
    results.push({
      storeId: store.id,
      store: store.name,
      warehouseId: String(id),
      warehouseName: String(warehouse.name || warehouse.warehouse_name || ""),
      requested: offerIds.length,
      updated: updateRows.filter((item) => item.updated).length,
      verifiedAtQuantity: verifiedOffers.size,
      errors,
    });
  }

  const report = {
    completedAt: new Date().toISOString(),
    offerPrefix,
    quantity,
    requested: results.reduce((sum, row) => sum + row.requested, 0),
    updated: results.reduce((sum, row) => sum + row.updated, 0),
    verifiedAtQuantity: results.reduce((sum, row) => sum + row.verifiedAtQuantity, 0),
    storesWithoutWarehouse: results
      .filter((row) => row.error === "no-active-warehouse")
      .map((row) => ({ store: row.store, products: row.requested })),
    results,
  };
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    completedAt: report.completedAt,
    offerPrefix,
    quantity,
    requested: report.requested,
    updated: report.updated,
    verifiedAtQuantity: report.verifiedAtQuantity,
    storesWithoutWarehouse: report.storesWithoutWarehouse,
    stores: results.map((row) => ({
      store: row.store,
      requested: row.requested,
      warehouse: row.warehouseName || null,
      updated: row.updated,
      verifiedAtQuantity: row.verifiedAtQuantity,
      errors: row.errors?.length || 0,
      error: row.error || null,
    })),
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
