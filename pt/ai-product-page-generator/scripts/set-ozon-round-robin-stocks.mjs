#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const quantity = Math.max(0, Number(process.argv[2] || 100));
const outputPath = path.resolve(
  process.argv[3] || "storage/ozon-500-stock-100-audit.json",
);
const appSecret = process.env.APP_SECRET || "replace-with-your-own-long-secret";
const auditFiles = [
  "storage/ozon-store-image-audit-main-final.json",
  "storage/ozon-store-image-audit-repair-final.json",
  "storage/ozon-store-image-audit-repair2-final.json",
];
const globalDedupeAudit = "storage/ozon-global-dedupe-audit.json";

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
  let payload = null;
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

async function readTargetOffers() {
  try {
    const audit = JSON.parse(await fs.readFile(globalDedupeAudit, "utf8"));
    if (Array.isArray(audit?.keep) && audit.keep.length) {
      const byStore = new Map();
      for (const product of audit.keep) {
        const storeName = String(product.store || "");
        const offerId = String(product.offerId || "");
        if (!storeName || !offerId) continue;
        const offers = byStore.get(storeName) || new Set();
        offers.add(offerId);
        byStore.set(storeName, offers);
      }
      return byStore;
    }
  } catch {
    // Fall back to the image audits before the global dedupe audit exists.
  }

  const byStore = new Map();
  for (const filename of auditFiles) {
    const audit = JSON.parse(await fs.readFile(filename, "utf8"));
    for (const store of audit.stores || []) {
      const offers = byStore.get(store.name) || new Set();
      for (const product of store.goal?.products || []) {
        // The 32 rejected cards were archived.  The final retained batch is
        // exactly the 500 cards that have a confirmed primary image.
        if (product.primaryImage) offers.add(String(product.offerId || ""));
      }
      byStore.set(store.name, offers);
    }
  }
  return byStore;
}

function activeWarehouses(payload) {
  const rows = Array.isArray(payload?.result)
    ? payload.result
    : payload?.result?.warehouses
      || payload?.result?.items
      || payload?.warehouses
      || payload?.items
      || [];
  return rows.filter((warehouse) =>
    ["created", "active", "working", "enabled", ""].includes(
      String(warehouse.status || "").toLowerCase(),
    ),
  );
}

function warehouseId(warehouse) {
  return Number(warehouse?.warehouse_id || warehouse?.warehouseId || warehouse?.id || 0);
}

try {
  const targetOffers = await readTargetOffers();
  const records = await prisma.ozonApiConfig.findMany();
  const results = [];
  for (const record of records) {
    const offerIds = [...(targetOffers.get(record.name) || [])].filter(Boolean);
    if (!offerIds.length) continue;
    const store = { ...record, apiKey: decrypt(record.apiKeyEncrypted) };
    const warehousePayload = await sellerRequest(store, "/v2/warehouse/list", {});
    const warehouses = activeWarehouses(warehousePayload);
    const warehouse = warehouses[0];
    const id = warehouseId(warehouse);
    if (!id) {
      results.push({
        storeId: store.id,
        store: store.name,
        requested: offerIds.length,
        updated: 0,
        verifiedAt100: 0,
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
        .filter((item) =>
          (item.stocks || []).some((stock) =>
            ["fbs", "rfbs"].includes(String(stock.type || "").toLowerCase())
            && Number(stock.present) === quantity,
          ),
        )
        .map((item) => String(item.offer_id || "")),
    );
    const updateErrors = updateRows
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
      verifiedAt100: verifiedOffers.size,
      errors: updateErrors,
    });
  }
  const report = {
    completedAt: new Date().toISOString(),
    quantity,
    requested: results.reduce((total, row) => total + row.requested, 0),
    updated: results.reduce((total, row) => total + row.updated, 0),
    verifiedAt100: results.reduce((total, row) => total + row.verifiedAt100, 0),
    storesWithoutWarehouse: results
      .filter((row) => row.error === "no-active-warehouse")
      .map((row) => ({ store: row.store, products: row.requested })),
    results,
  };
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    completedAt: report.completedAt,
    quantity: report.quantity,
    requested: report.requested,
    updated: report.updated,
    verifiedAt100: report.verifiedAt100,
    storesWithoutWarehouse: report.storesWithoutWarehouse,
    stores: results.map((row) => ({
      store: row.store,
      requested: row.requested,
      warehouse: row.warehouseName || null,
      updated: row.updated,
      verifiedAt100: row.verifiedAt100,
      errors: row.errors?.length || 0,
      error: row.error || null,
    })),
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
