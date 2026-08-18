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

const appSecret = process.env.APP_SECRET || "replace-with-your-own-long-secret";
const prefixes = String(args.get("prefixes") || "RR500-,RR500R-,RR500R2-")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const requestedStoreId = String(args.get("store-id") || "").trim();
const limit = Math.max(0, Number(args.get("limit") || 0));
const concurrency = Math.max(1, Math.min(8, Number(args.get("concurrency") || 4)));
const dryRun = args.get("dry-run") === "true";
const retryFailed = args.get("retry-failed") === "true";
const artifactDirectory = path.resolve(
  args.get("artifacts") || "../../artifacts",
);
const checkpointPath = path.resolve(
  args.get("checkpoint") || "storage/ozon-500-image-repair-state.json",
);
const auditPath = path.resolve(
  args.get("audit") || "storage/ozon-500-image-repair-audit.json",
);
const planPath = path.resolve(
  args.get("plan") || "storage/ozon-500-round-robin-plan.json",
);

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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filename, payload) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filename);
}

async function sellerRequest(store, endpoint, body, timeoutMs = 60_000) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
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
      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = { raw: responseText };
      }
      if (response.ok) return payload;
      const error = new Error(
        `${endpoint} ${response.status}: ${JSON.stringify(payload)}`,
      );
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
      if (Number(error?.status || 0) >= 400 && Number(error?.status || 0) < 500) {
        if (Number(error?.status || 0) !== 429) throw error;
      }
      await delay(attempt * 1_500);
    }
  }
  throw lastError || new Error(`${endpoint} 请求失败`);
}

const artifactRowKeys = [
  "candidates",
  "deferred_candidates",
  "provisional_candidates",
  "rows",
  "results",
  "auto_selected",
  "manual_review",
  "records",
];

function artifactRows(payload) {
  if (Array.isArray(payload)) return payload.filter((row) => row && typeof row === "object");
  if (!payload || typeof payload !== "object") return [];
  return artifactRowKeys.flatMap((key) =>
    Array.isArray(payload[key])
      ? payload[key].filter((row) => row && typeof row === "object")
      : [],
  );
}

function sourceSkuFromOffer(offerId) {
  const match = String(offerId || "").match(/(\d{6,})$/);
  return match?.[1] || "";
}

function normalizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!/^https:\/\//i.test(url)) return "";
  // Discovery artifacts retain Ozon's c600 preview.  Removing only the resize
  // segment yields the original public JPG, which is more suitable for Seller.
  return url.replace(/\/(?:c\d+|wc\d+)\//i, "/");
}

async function buildSourceImageMap() {
  const entries = await fs.readdir(artifactDirectory, { withFileTypes: true });
  const ranked = new Map();
  const setImage = (sourceSku, value, priority) => {
    const imageUrl = normalizeImageUrl(value);
    if (!/^\d{6,}$/.test(sourceSku) || !imageUrl) return;
    const current = ranked.get(sourceSku);
    if (!current || priority > current.priority) {
      ranked.set(sourceSku, { imageUrl, priority });
    }
  };
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const payload = await readJson(path.join(artifactDirectory, entry.name), null);
    for (const row of artifactRows(payload)) {
      const sourceSku = String(
        row.product_id || row.productId || row.id || "",
      ).trim();
      setImage(sourceSku, row.image_url || row.imageUrl, 100);
      setImage(sourceSku, row.raw?.photo || row.raw?.image_url, 90);
      for (const match of Array.isArray(row.matches) ? row.matches : []) {
        if (!match || typeof match !== "object") continue;
        setImage(
          sourceSku,
          match.selected_sku?.imageUrl || match.selected_sku?.image_url,
          80,
        );
        setImage(sourceSku, match.image || match.imageUrl || match.image_url, 70);
      }
    }
  }
  const plan = await readJson(planPath, null);
  for (const row of artifactRows(plan)) {
    const sourceSku = String(
      row.sourceSku || row.product_id || row.productId || row.id || "",
    ).trim();
    setImage(sourceSku, row.imageUrl || row.image_url, 200);
  }
  return new Map([...ranked].map(([key, value]) => [key, value.imageUrl]));
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

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function pictureInfo(store, productIds) {
  const items = [];
  for (const batch of chunks(productIds, 1000)) {
    const payload = await sellerRequest(store, "/v2/product/pictures/info", {
      product_id: batch.map(String),
    });
    items.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return items;
}

async function runPool(items, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

const checkpoint = await readJson(checkpointPath, {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  entries: {},
});

try {
  const sourceImages = await buildSourceImageMap();
  const records = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "asc" }],
  });
  const stores = records
    .filter((record) => !requestedStoreId || record.id === requestedStoreId)
    .map((record) => ({ ...record, apiKey: decrypt(record.apiKeyEncrypted) }));
  const allCandidates = [];
  const missingSourceImages = [];
  const beforeByStore = {};

  for (const store of stores) {
    const products = (await listProducts(store)).filter((product) =>
      prefixes.some((prefix) => String(product.offer_id || "").startsWith(prefix)),
    );
    const pictures = await pictureInfo(
      store,
      products.map((product) => String(product.product_id || "")).filter(Boolean),
    );
    const picturesByProduct = new Map(
      pictures.map((item) => [String(item.product_id || ""), item]),
    );
    let ready = 0;
    let missing = 0;
    for (const product of products) {
      const productId = String(product.product_id || "");
      const offerId = String(product.offer_id || "");
      const picture = picturesByProduct.get(productId);
      const hasImage = Boolean(
        picture && (
          (Array.isArray(picture.primary_photo) && picture.primary_photo.length) ||
          (Array.isArray(picture.photo) && picture.photo.length)
        ),
      );
      if (hasImage) {
        ready += 1;
        continue;
      }
      missing += 1;
      const sourceSku = sourceSkuFromOffer(offerId);
      const imageUrl = sourceImages.get(sourceSku) || "";
      if (!imageUrl) {
        missingSourceImages.push({
          storeId: store.id,
          store: store.name,
          offerId,
          productId,
          sourceSku,
        });
        continue;
      }
      allCandidates.push({
        store,
        storeId: store.id,
        storeName: store.name,
        offerId,
        productId,
        sourceSku,
        imageUrl,
      });
    }
    beforeByStore[store.id] = {
      store: store.name,
      listed: products.length,
      ready,
      missing,
    };
  }

  const pending = allCandidates.filter((candidate) => {
    const key = `${candidate.storeId}:${candidate.offerId}`;
    const status = checkpoint.entries[key]?.status;
    return status !== "submitted" && (retryFailed || status !== "failed");
  });
  const selected = limit ? pending.slice(0, limit) : pending;
  let completedSinceSave = 0;
  await runPool(selected, async (candidate, index) => {
    const key = `${candidate.storeId}:${candidate.offerId}`;
    try {
      const response = dryRun
        ? { dryRun: true }
        : await sellerRequest(candidate.store, "/v1/product/pictures/import", {
          product_id: Number(candidate.productId),
          images: [candidate.imageUrl],
        }, 120_000);
      checkpoint.entries[key] = {
        storeId: candidate.storeId,
        store: candidate.storeName,
        offerId: candidate.offerId,
        productId: candidate.productId,
        sourceSku: candidate.sourceSku,
        imageUrl: candidate.imageUrl,
        status: dryRun ? "dry-run" : "submitted",
        submittedAt: new Date().toISOString(),
        response,
      };
      completedSinceSave += 1;
      if (completedSinceSave >= 10) {
        completedSinceSave = 0;
        await writeJson(checkpointPath, checkpoint);
      }
      process.stdout.write(
        `[${index + 1}/${selected.length}] ${candidate.storeName} ${candidate.offerId} 已提交图片\n`,
      );
    } catch (error) {
      checkpoint.entries[key] = {
        storeId: candidate.storeId,
        store: candidate.storeName,
        offerId: candidate.offerId,
        productId: candidate.productId,
        sourceSku: candidate.sourceSku,
        imageUrl: candidate.imageUrl,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
      process.stderr.write(
        `[${index + 1}/${selected.length}] ${candidate.storeName} ${candidate.offerId} 失败：${checkpoint.entries[key].error}\n`,
      );
    }
  });
  checkpoint.updatedAt = new Date().toISOString();
  await writeJson(checkpointPath, checkpoint);

  if (!dryRun && selected.length) await delay(15_000);
  const verifiedByStore = {};
  for (const store of stores) {
    const storeRows = allCandidates.filter((candidate) => candidate.storeId === store.id);
    const pictures = await pictureInfo(store, storeRows.map((row) => row.productId));
    const readyProductIds = new Set(
      pictures
        .filter((item) =>
          (Array.isArray(item.primary_photo) && item.primary_photo.length) ||
          (Array.isArray(item.photo) && item.photo.length),
        )
        .map((item) => String(item.product_id || "")),
    );
    verifiedByStore[store.id] = {
      store: store.name,
      mappedMissingBefore: storeRows.length,
      readyAfter: storeRows.filter((row) => readyProductIds.has(row.productId)).length,
      pendingAfter: storeRows.filter((row) => !readyProductIds.has(row.productId)).length,
    };
  }

  const audit = {
    completedAt: new Date().toISOString(),
    dryRun,
    prefixes,
    sourceImageMapSize: sourceImages.size,
    beforeByStore,
    mappedMissingBefore: allCandidates.length,
    selected: selected.length,
    missingSourceImages,
    verifiedByStore,
    checkpointPath,
  };
  await writeJson(auditPath, audit);
  console.log(JSON.stringify(audit, null, 2));
} finally {
  await prisma.$disconnect();
}
