#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function main() {
  const publicBaseUrl = (
    argValue("--public-base-url") ||
    process.env.LISTING_IMAGE_PUBLIC_BASE_URL ||
    "https://cdn.jsdelivr.net/gh/L-Keyyy/ozon-product-images@main"
  ).replace(/\/+$/, "");
  const legacyOnly = process.argv.includes("--legacy-only");
  const batchSize = Math.max(1, Math.min(5, Number(argValue("--batch-size") || 1)));
  const limit = Math.max(0, Number(argValue("--limit") || 0));
  if (!/^https:\/\//i.test(publicBaseUrl)) {
    throw new Error("请通过 --public-base-url 传入可公开读取图片的 HTTPS 地址。");
  }

  const checkpointPath = path.resolve(
    argValue("--checkpoint") ||
      "storage/pet-toy-batch/production-checkpoint.json",
  );
  const imageMapPath = path.resolve(
    argValue("--image-map") ||
      "storage/pet-toy-batch/generated-image-map.json",
  );
  const auditPath = path.resolve(
    argValue("--audit") ||
      "storage/pet-toy-batch/ozon-image-repair-audit.json",
  );
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  const imageMap = JSON.parse(await fs.readFile(imageMapPath, "utf8"));
  const fileByItemId = new Map(
    imageMap.filter((entry) => entry.exists && entry.file).map((entry) => [entry.id, entry.file]),
  );
  const matchedJobs = checkpoint.jobs.filter(
    (job) =>
      job.status === "imported" &&
      job.result?.offerId &&
      job.result?.productId &&
      fileByItemId.has(job.input?.workflowItemId),
  );
  const jobs = limit ? matchedJobs.slice(0, limit) : matchedJobs;

  const prisma = new PrismaClient();
  const config = await prisma.ozonApiConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!config) throw new Error("未找到启用中的 Ozon Seller API 配置。");
  const [ivHex, tagHex, encryptedHex] = config.apiKeyEncrypted.split(":");
  const key = crypto
    .createHash("sha256")
    .update(process.env.APP_SECRET || "banana-mall-local-secret")
    .digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const apiKey = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
  const headers = {
    "Client-Id": config.clientId,
    "Api-Key": apiKey,
    "Content-Type": "application/json",
  };

  async function seller(endpoint, body) {
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await fetch(`${config.baseUrl}${endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;
        if (!response.ok) {
          const error = new Error(
            `${endpoint} ${response.status}: ${payload?.message || text}`,
          );
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
        } else {
          return payload;
        }
      } catch (error) {
        lastError = error;
        if (/\s4\d\d:/.test(error instanceof Error ? error.message : "")) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
    throw lastError || new Error(`${endpoint} 请求失败。`);
  }

  const offerIds = jobs.map((job) => job.result.offerId);
  const info = await seller("/v3/product/info/list", { offer_id: offerIds });
  const attributes = await seller("/v4/product/info/attributes", {
    filter: { offer_id: offerIds, visibility: "ALL" },
    limit: 1000,
  });
  const infoByOffer = new Map((info.items || []).map((item) => [item.offer_id, item]));
  const attributesByOffer = new Map(
    (attributes.result || []).map((item) => [item.offer_id, item]),
  );
  const skipped = [];
  const importItems = [];

  for (const job of jobs) {
    const itemInfo = infoByOffer.get(job.result.offerId);
    const itemAttributes = attributesByOffer.get(job.result.offerId);
    if (!itemInfo || !itemAttributes) {
      skipped.push({ offerId: job.result.offerId, reason: "Ozon 商品详情缺失" });
      continue;
    }
    const currentPrimary = String(
      Array.isArray(itemInfo.primary_image)
        ? itemInfo.primary_image[0] || ""
        : itemInfo.primary_image || "",
    );
    if (
      legacyOnly &&
      !/(?:\.free\.pinggy\.net|trycloudflare\.com|localhost|127\.0\.0\.1)/i.test(currentPrimary)
    ) {
      skipped.push({ offerId: job.result.offerId, reason: "当前商品未使用旧临时图片链路" });
      continue;
    }
    if ((itemInfo.errors || []).some((error) => error.code === "price_out_of_range")) {
      skipped.push({ offerId: job.result.offerId, reason: "Ozon 售价低于类目下限" });
      continue;
    }
    const fileName = fileByItemId.get(job.input.workflowItemId);
    const primaryImage = `${publicBaseUrl}/api/files/generated/listing-workflow/${encodeURIComponent(fileName)}`;
    const check = await fetch(primaryImage, {
      method: "HEAD",
      signal: AbortSignal.timeout(20_000),
    });
    if (!check.ok || !String(check.headers.get("content-type") || "").startsWith("image/")) {
      skipped.push({ offerId: job.result.offerId, reason: "公网图片地址没有返回图片" });
      continue;
    }
    importItems.push({
      productId: String(job.result.productId),
      payload: {
        description_category_id: itemAttributes.description_category_id,
        type_id: itemAttributes.type_id,
        price: itemInfo.price,
        offer_id: itemInfo.offer_id,
        name: itemAttributes.name,
        currency_code: itemInfo.currency_code,
        depth: itemAttributes.depth,
        width: itemAttributes.width,
        height: itemAttributes.height,
        dimension_unit: itemAttributes.dimension_unit,
        weight: itemAttributes.weight,
        weight_unit: itemAttributes.weight_unit,
        primary_image: primaryImage,
        // 旧附图里也可能残留临时隧道地址。修复时仅提交已经永久化的主图，
        // 避免 Ozon 再次抓取 Pinggy/Cloudflare 临时链接。
        images: [],
        attributes: itemAttributes.attributes || [],
      },
    });
  }

  const beforePictures = [];
  for (const batch of chunks(importItems.map((item) => item.productId), 100)) {
    const result = await seller("/v2/product/pictures/info", { product_id: batch });
    beforePictures.push(...(result.items || []));
  }
  const expectedPrimaryByProduct = new Map(
    importItems.map((item) => [item.productId, item.payload.primary_image]),
  );
  const hasExpectedPrimary = (picture) =>
    (picture.primary_photo || []).includes(
      expectedPrimaryByProduct.get(String(picture.product_id)),
    );
  const readyBefore = new Set(
    beforePictures
      .filter(
        (item) =>
          !(item.errors || []).length &&
          hasExpectedPrimary(item),
      )
      .map((item) => String(item.product_id)),
  );
  const pendingImports = importItems.filter((item) => !readyBefore.has(item.productId));
  const taskIds = [];
  const imported = [];
  const failed = [];
  const readyPictures = [...beforePictures.filter((item) => readyBefore.has(String(item.product_id)))];
  const pictureErrors = [];
  for (const batch of chunks(pendingImports, batchSize)) {
    const response = await seller("/v3/product/import", {
      items: batch.map((item) => item.payload),
    });
    const taskId = Number(response?.result?.task_id);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      throw new Error("Ozon 图片修复任务缺少 task_id。");
    }
    taskIds.push(taskId);
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const status = await seller("/v1/product/import/info", { task_id: taskId });
      const items = status?.result?.items || [];
      if (
        items.length &&
        items.every((item) => ["imported", "failed", "skipped"].includes(item.status))
      ) {
        const batchImported = items.filter((item) =>
          ["imported", "skipped"].includes(item.status),
        );
        imported.push(...batchImported);
        failed.push(...items.filter((item) => item.status === "failed"));
        const productIds = batchImported.map((item) => String(item.product_id)).filter(Boolean);
        const pictureDeadline = Date.now() + 45_000;
        let lastPictures = [];
        while (productIds.length && Date.now() < pictureDeadline) {
          const pictureResult = await seller("/v2/product/pictures/info", {
            product_id: productIds,
          });
          lastPictures = pictureResult.items || [];
          if (
            lastPictures.length === productIds.length &&
            lastPictures.every(
              (picture) =>
                !(picture.errors || []).length &&
                hasExpectedPrimary(picture),
            )
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        const batchReadyPictures = lastPictures.filter(
          (picture) =>
            !(picture.errors || []).length &&
            hasExpectedPrimary(picture),
        );
        readyPictures.push(...batchReadyPictures);
        const readyIds = new Set(readyPictures.map((picture) => String(picture.product_id)));
        pictureErrors.push(
          ...lastPictures
            .filter((picture) => !readyIds.has(String(picture.product_id)))
            .map((picture) => ({
              productId: picture.product_id,
              errors: picture.errors || [],
            })),
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  const audit = {
    completedAt: new Date().toISOString(),
    publicBaseUrl,
    mapped: jobs.length,
    alreadyReady: readyBefore.size,
    submitted: pendingImports.length,
    imported: imported.length,
    failed,
    skipped,
    picturesReady: readyPictures.length,
    pictureErrors,
    taskIds,
  };
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(audit, null, 2));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
