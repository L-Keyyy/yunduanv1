#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const strictAuditPath = path.resolve(
  process.argv[2] || "storage/ozon-rr4x-strict-display-audit-20260811.json",
);
const planPath = path.resolve(
  process.argv[3] || "storage/ozon-500-round-robin-plan.json",
);
const outputPath = path.resolve(
  process.argv[4] || "storage/rr4x-missing-primary-direct-repair.json",
);

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

function normalizeSourceImage(value) {
  const url = String(value || "").trim();
  if (!/^https:\/\//i.test(url)) return "";
  return url.replace(
    /\.(jpe?g|png|webp)_\d+x\d+(?:q\d+)?\.(?:jpe?g|png|webp)(?=$|[?#])/i,
    ".$1",
  );
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
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const [audit, plan, records] = await Promise.all([
    fs.readFile(strictAuditPath, "utf8").then(JSON.parse),
    fs.readFile(planPath, "utf8").then(JSON.parse),
    prisma.ozonApiConfig.findMany(),
  ]);
  const storeById = new Map(records.map((record) => [record.id, {
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }]));
  const candidateBySku = new Map(
    (Array.isArray(plan?.candidates) ? plan.candidates : [])
      .map((candidate) => [String(candidate.sourceSku || ""), candidate]),
  );
  const targets = (Array.isArray(audit?.stores) ? audit.stores : []).flatMap((row) =>
    (Array.isArray(row?.goal?.products) ? row.goal.products : [])
      .filter((product) => product.isCreated === true && !product.processedPrimaryImage)
      .map((product) => {
        const sourceSku = String(product.offerId || "").match(/(\d{6,})$/)?.[1] || "";
        const candidate = candidateBySku.get(sourceSku);
        return {
          storeId: row.configId,
          storeName: row.name,
          offerId: product.offerId,
          productId: String(product.productId || ""),
          sourceSku,
          sourceImage: normalizeSourceImage(candidate?.imageUrl ?? candidate?.image_url),
        };
      }),
  );

  const results = [];
  for (const target of targets) {
    const store = storeById.get(target.storeId);
    try {
      if (!store) throw new Error("店铺配置不存在");
      if (!target.sourceImage) throw new Error("计划中缺少商品原图");
      const response = await sellerRequest(store, "/v1/product/pictures/import", {
        product_id: Number(target.productId),
        images: [target.sourceImage],
      });
      results.push({ ...target, status: "submitted", response });
      process.stdout.write(`${target.storeName} ${target.offerId}: 原始主图已直接提交 Ozon\n`);
    } catch (error) {
      results.push({
        ...target,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const output = {
    completedAt: new Date().toISOString(),
    requested: targets.length,
    submitted: results.filter((row) => row.status === "submitted").length,
    failed: results.filter((row) => row.status === "failed").length,
    results,
  };
  await writeJsonAtomic(outputPath, output);
  console.log(JSON.stringify({
    requested: output.requested,
    submitted: output.submitted,
    failed: output.failed,
    outputPath,
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

