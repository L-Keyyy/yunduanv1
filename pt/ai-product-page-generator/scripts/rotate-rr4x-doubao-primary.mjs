#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    apply: false,
    checkpoint: "storage/rr4x-ai-image-replacement-checkpoint.json",
    cutoff: "storage/rr4x-doubao-primary-rotation-cutoff.json",
    audit: "storage/rr4x-doubao-primary-rotation-audit.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") args.apply = true;
    else if (token === "--checkpoint") args.checkpoint = String(argv[++index] || "");
    else if (token === "--cutoff") args.cutoff = String(argv[++index] || "");
    else if (token === "--audit") args.audit = String(argv[++index] || "");
    else throw new Error(`未知参数：${token}`);
  }
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

function text(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function existingImages(item) {
  const primary = Array.isArray(item?.primary_image)
    ? text(item.primary_image[0])
    : text(item?.primary_image);
  return Array.from(new Set([
    primary,
    ...(Array.isArray(item?.images) ? item.images.map(text) : []),
  ].filter(Boolean)));
}

async function sellerRequest(store, endpoint, body, timeoutMs = 120_000) {
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
      const payload = await response.json().catch(() => null);
      if (response.ok) return payload;
      const error = new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
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

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkpoint = JSON.parse(await fs.readFile(path.resolve(args.checkpoint), "utf8"));
  const cutoffConfig = JSON.parse(await fs.readFile(path.resolve(args.cutoff), "utf8"));
  const cutoff = Date.parse(cutoffConfig.completedAtOrBefore);
  if (!Number.isFinite(cutoff)) throw new Error("豆包主图轮换截止时间格式错误");

  const records = await prisma.ozonApiConfig.findMany({ orderBy: [{ updatedAt: "asc" }, { id: "asc" }] });
  const stores = new Map(records.map((record) => [record.id, {
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }]));
  const candidates = Object.values(checkpoint.products || {}).filter((row) => {
    if (row?.status !== "uploaded" || row?.generationModel !== "doubao-image-web") return false;
    const generation = checkpoint.generations?.[row.generationKey];
    return Date.parse(generation?.completedAt || "") <= cutoff
      && Array.isArray(row.generatedImageUrls)
      && row.generatedImageUrls.length >= 4;
  });

  const rows = [];
  for (const [storeId, storeRows] of Object.entries(Object.groupBy(candidates, (row) => row.storeId))) {
    const store = stores.get(storeId);
    if (!store) continue;
    const live = await productInfo(store, storeRows.map((row) => row.offerId));
    const byOffer = new Map(live.map((item) => [text(item.offer_id), item]));
    for (const row of storeRows) {
      const item = byOffer.get(row.offerId);
      const current = existingImages(item);
      const generated = row.generatedImageUrls.map(text).filter(Boolean).slice(0, 4);
      const rotated = [generated[1], generated[2], generated[3], generated[0]];
      const images = Array.from(new Set([
        ...rotated,
        ...current.filter((url) => !generated.includes(url)),
      ].filter(Boolean))).slice(0, 30);
      const alreadyRotated = current[0] === rotated[0];
      let response = null;
      let error = null;
      if (args.apply && !alreadyRotated) {
        try {
          response = await sellerRequest(store, "/v1/product/pictures/import", {
            product_id: Number(row.productId),
            images,
          });
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      rows.push({
        storeId,
        storeName: store.name,
        offerId: row.offerId,
        productId: row.productId,
        generationKey: row.generationKey,
        beforePrimary: current[0] || "",
        targetPrimary: rotated[0] || "",
        imageCount: images.length,
        alreadyRotated,
        applied: args.apply && !alreadyRotated && !error,
        response,
        error,
      });
    }
  }

  const audit = {
    generatedAt: new Date().toISOString(),
    apply: args.apply,
    cutoff: cutoffConfig.completedAtOrBefore,
    selected: candidates.length,
    alreadyRotated: rows.filter((row) => row.alreadyRotated).length,
    applied: rows.filter((row) => row.applied).length,
    failed: rows.filter((row) => row.error).length,
    rows,
  };
  await writeJsonAtomic(path.resolve(args.audit), audit);
  console.log(JSON.stringify({
    generatedAt: audit.generatedAt,
    apply: audit.apply,
    selected: audit.selected,
    alreadyRotated: audit.alreadyRotated,
    applied: audit.applied,
    failed: audit.failed,
    auditPath: path.resolve(args.audit),
  }, null, 2));
  if (audit.failed) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
