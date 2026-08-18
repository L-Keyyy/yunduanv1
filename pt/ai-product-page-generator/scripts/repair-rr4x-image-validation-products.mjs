#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
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
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status}: ${text}`);
  }
  return payload;
}

async function pollImport(store, taskId) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const response = await sellerRequest(store, "/v1/product/import/info", {
      task_id: Number(taskId),
    });
    const items = Array.isArray(response?.result?.items) ? response.result.items : [];
    if (items.length && items.every((item) =>
      ["imported", "failed", "skipped"].includes(item.status)
    )) return items;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return [];
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const strictAuditPath = path.resolve(arg(
    "--strict-audit",
    "storage/ozon-rr4x-strict-display-audit-20260811.json",
  ));
  const checkpointPath = path.resolve(arg(
    "--checkpoint",
    "storage/rr4x-ai-image-replacement-checkpoint.json",
  ));
  const outputPath = path.resolve(arg(
    "--audit",
    "storage/rr4x-image-validation-product-repair.json",
  ));
  const onlyOfferId = arg("--offer-id");
  const [strictAudit, checkpoint, records] = await Promise.all([
    fs.readFile(strictAuditPath, "utf8").then(JSON.parse),
    fs.readFile(checkpointPath, "utf8").then(JSON.parse),
    prisma.ozonApiConfig.findMany(),
  ]);
  const storeById = new Map(records.map((record) => [record.id, {
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }]));
  const checkpointProductByOffer = new Map(
    Object.values(checkpoint.products || {}).map((row) => [row.offerId, row]),
  );
  const targets = (strictAudit.stores || []).flatMap((storeRow) =>
    (storeRow.goal?.products || []).filter((product) =>
      product.isCreated === true
      && (product.errors || []).some((error) => error.code === "image_not_upload")
      && (!onlyOfferId || product.offerId === onlyOfferId)
    ).map((product) => ({
      ...product,
      storeId: storeRow.configId,
      storeName: storeRow.name,
      errorCodes: (product.errors || []).map((error) => error.code),
    })),
  );
  const results = [];

  for (const target of targets) {
    const store = storeById.get(target.storeId);
    try {
      if (!store) throw new Error("店铺配置不存在");
      const saved = checkpointProductByOffer.get(target.offerId);
      const generation = checkpoint.generations?.[saved?.generationKey];
      const generated = Array.isArray(generation?.urls)
        ? generation.urls.filter((url) => /^https:\/\//i.test(String(url)))
        : [];
      if (generated.length !== 4) throw new Error("检查点中缺少完整四张生成图");

      const [infoResponse, attributesResponse, picturesResponse] = await Promise.all([
        sellerRequest(store, "/v3/product/info/list", { offer_id: [target.offerId] }),
        sellerRequest(store, "/v4/product/info/attributes", {
          filter: { offer_id: [target.offerId], visibility: "ALL" },
          limit: 100,
        }),
        sellerRequest(store, "/v2/product/pictures/info", {
          product_id: [Number(target.productId)],
        }),
      ]);
      const info = infoResponse?.items?.[0];
      const attributes = attributesResponse?.result?.[0];
      if (!info || !attributes) throw new Error("Ozon 商品详情或属性缺失");
      const picture = picturesResponse?.items?.[0] || {};
      const currentImages = [
        ...(picture.primary_photo || []),
        ...(picture.photo || []),
        ...(picture.color_photo || []),
      ].map(String).filter(Boolean);
      const retained = [...new Set(currentImages.filter((url) => !generated.includes(url)))];
      const dropDeclinedDescription = target.errorCodes.includes("DESCRIPTION_DECLINE");
      const payload = {
        description_category_id: attributes.description_category_id,
        type_id: attributes.type_id,
        price: info.price,
        offer_id: target.offerId,
        name: attributes.name,
        currency_code: info.currency_code,
        depth: attributes.depth,
        width: attributes.width,
        height: attributes.height,
        dimension_unit: attributes.dimension_unit,
        weight: attributes.weight,
        weight_unit: attributes.weight_unit,
        primary_image: generated[0],
        images: [...generated.slice(1), ...retained].slice(0, 29),
        attributes: (attributes.attributes || []).filter((attribute) =>
          !dropDeclinedDescription || Number(attribute.id) !== 4194
        ),
        ...(attributes.complex_attributes?.length
          ? { complex_attributes: attributes.complex_attributes }
          : {}),
      };
      const response = await sellerRequest(store, "/v3/product/import", {
        items: [payload],
      });
      const taskId = response?.result?.task_id;
      const items = taskId ? await pollImport(store, taskId) : [];
      results.push({
        storeId: target.storeId,
        storeName: target.storeName,
        offerId: target.offerId,
        productId: target.productId,
        taskId: taskId ? String(taskId) : null,
        droppedDeclinedDescription: dropDeclinedDescription,
        generatedImageCount: generated.length,
        status: items[0]?.status || (taskId ? "submitted" : "failed"),
        items,
      });
      process.stdout.write(
        `${target.storeName} ${target.offerId}: 完整商品图片更新 ${items[0]?.status || "submitted"}\n`,
      );
    } catch (error) {
      results.push({
        storeId: target.storeId,
        storeName: target.storeName,
        offerId: target.offerId,
        productId: target.productId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const output = {
    completedAt: new Date().toISOString(),
    requested: targets.length,
    imported: results.filter((row) => row.status === "imported").length,
    failed: results.filter((row) => row.status === "failed").length,
    pending: results.filter((row) => !["imported", "failed"].includes(row.status)).length,
    results,
  };
  await writeJsonAtomic(outputPath, output);
  console.log(JSON.stringify({
    requested: output.requested,
    imported: output.imported,
    failed: output.failed,
    pending: output.pending,
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

