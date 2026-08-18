#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const checkpoint = JSON.parse(await fs.readFile("storage/pet-toy-batch/production-checkpoint.json", "utf8"));
const offerIds = checkpoint.jobs.filter((job) => job.status === "imported").map((job) => job.result.offerId);
const config = await prisma.ozonApiConfig.findFirst({ where: { isActive: true }, orderBy: { updatedAt: "desc" } });
const [iv, tag, encrypted] = config.apiKeyEncrypted.split(":");
const key = crypto.createHash("sha256").update(process.env.APP_SECRET || "banana-mall-local-secret").digest();
const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
decipher.setAuthTag(Buffer.from(tag, "hex"));
const apiKey = Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]).toString("utf8");
const response = await fetch(`${config.baseUrl}/v3/product/info/list`, {
  method: "POST",
  headers: { "Client-Id": config.clientId, "Api-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ offer_id: offerIds }),
});
const payload = await response.json();
if (!response.ok) throw new Error(JSON.stringify(payload));
const items = payload.items || [];
const stocksResponse = await fetch(`${config.baseUrl}/v4/product/info/stocks`, {
  method: "POST",
  headers: { "Client-Id": config.clientId, "Api-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ filter: { offer_id: offerIds, visibility: "ALL" }, limit: 100 }),
});
const stocksPayload = await stocksResponse.json();
if (!stocksResponse.ok) throw new Error(JSON.stringify(stocksPayload));
const stockItems = stocksPayload.items || [];
const stock100 = stockItems.filter((item) =>
  (item.stocks || []).some((stock) => Number(stock.present) === 100),
);
const attributesResponse = await fetch(`${config.baseUrl}/v4/product/info/attributes`, {
  method: "POST",
  headers: { "Client-Id": config.clientId, "Api-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ filter: { offer_id: offerIds, visibility: "ALL" }, limit: 100 }),
});
const attributesPayload = await attributesResponse.json();
if (!attributesResponse.ok) throw new Error(JSON.stringify(attributesPayload));
const hanAttributes = (attributesPayload.result || []).flatMap((product) =>
  (product.attributes || []).flatMap((attribute) =>
    (attribute.values || []).filter((value) => /[\u3400-\u9fff]/u.test(String(value.value || ""))).map((value) => ({
      offerId: product.offer_id,
      attributeId: attribute.id,
      value: value.value,
    })),
  ),
);
const chinese = items.filter((item) => /[\u3400-\u9fff]/u.test(String(item.name || "")));
const statuses = Object.entries(items.reduce((result, item) => {
  const key = item.statuses?.moderate_status || item.statuses?.status_name || item.statuses?.status || "unknown";
  result[key] = (result[key] || 0) + 1;
  return result;
}, {}));
const errorCodes = Object.entries(items.flatMap((item) => item.errors || []).reduce((result, error) => {
  const key = error.code || "unknown";
  result[key] = (result[key] || 0) + 1;
  return result;
}, {})).sort((a, b) => b[1] - a[1]);
const declined = items.filter((item) => item.statuses?.moderate_status === "declined");
const primaryImageOf = (item) => String(
  Array.isArray(item.primary_image) ? item.primary_image[0] || "" : item.primary_image || "",
);
const legacyPrimaryOffers = items
  .filter((item) => /(?:\.free\.pinggy\.net|trycloudflare\.com|localhost|127\.0\.0\.1)/i.test(primaryImageOf(item)))
  .map((item) => ({ offerId: item.offer_id, primaryImage: primaryImageOf(item) }));
const permanentPrimaryOffers = items
  .filter((item) => /cdn\.jsdelivr\.net\/gh\/L-Keyyy\/ozon-product-images@/i.test(primaryImageOf(item)))
  .map((item) => item.offer_id);
console.log(JSON.stringify({
  requested: offerIds.length,
  found: items.length,
  stockFound: stockItems.length,
  stock100: stock100.length,
  stockNot100: stockItems.filter((item) => !(item.stocks || []).some((stock) => Number(stock.present) === 100)).map((item) => item.offer_id),
  chineseNames: chinese.length,
  chineseOffers: chinese.map((item) => item.offer_id),
  hanAttributeCount: hanAttributes.length,
  hanAttributeExamples: hanAttributes.slice(0, 20),
  legacyPrimaryCount: legacyPrimaryOffers.length,
  legacyPrimaryOffers,
  permanentPrimaryCount: permanentPrimaryOffers.length,
  statuses,
  errorCodes,
  imageErrorProducts: items.filter((item) =>
    (item.errors || []).some((error) => ["primary_image_load_failed", "pics_http_error", "all_image_failed"].includes(error.code)),
  ).map((item) => ({
    offerId: item.offer_id,
    status: item.statuses?.status_name,
    primaryImage: item.primary_image,
    images: item.images,
  })),
  notSelling: items.filter((item) => item.statuses?.status_name === "Не продается").map((item) => ({
    offerId: item.offer_id,
    name: item.name,
    statuses: item.statuses,
    errors: item.errors,
  })),
  declinedExamples: declined.slice(0, 5).map((item) => ({
    offerId: item.offer_id,
    name: item.name,
    primaryImage: item.primary_image,
    imageCount: Array.isArray(item.images) ? item.images.length : 0,
    statuses: item.statuses,
    errors: item.errors,
  })),
}, null, 2));
await prisma.$disconnect();
