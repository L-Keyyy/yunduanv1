#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  asRecord,
  chooseSingleVariant,
  readJsonFile,
  textValue,
  variantId,
  writeJsonAtomic,
} from "./lib/pet-toy-batch.mjs";

const CDP_BASE = "http://127.0.0.1:9222";
const APP_BASE = "http://127.0.0.1:3000";
const MANIFEST_PATH = path.resolve("storage/pet-toy-batch/sources.json");
const METADATA_PATH = path.resolve("storage/pet-toy-batch/card-metadata.json");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
  const targets = await fetch(`${CDP_BASE}/json/list`).then((response) => response.json());
  const target = targets.find((entry) => entry.type === "page" && String(entry.url).includes("s.1688.com/page/pccps.html"));
  if (!target?.webSocketDebuggerUrl) throw new Error("没有找到 1688 搜索页");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    if (!pending.has(payload.id)) return;
    const task = pending.get(payload.id);
    pending.delete(payload.id);
    clearTimeout(task.timer);
    if (payload.error) task.reject(new Error(payload.error.message));
    else task.resolve(payload.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 45_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true });
    return result.result?.value;
  };
  return { socket, call, evaluate };
}

async function readCards(cdp) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const cards = await cdp.evaluate(`(() => [...document.querySelectorAll('.banana-mall-1688-card-collector')].map((node) => {
      const card = node.closest('a[href]');
      const lines = String(card?.innerText || '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const yenIndex = lines.indexOf('¥');
      let price = '';
      if (yenIndex >= 0) {
        price = lines[yenIndex + 1] || '';
        if (/^\\./.test(lines[yenIndex + 2] || '')) price += lines[yenIndex + 2];
      }
      const image = [...(card?.querySelectorAll('img') || [])]
        .map((entry) => entry.currentSrc || entry.src || '')
        .find((url) => /cbu01\\.alicdn\\.com|alicdn\\.com\\/img\\/ibank/.test(url)) || '';
      return {
        offerId: node.dataset.offerId || '',
        title: lines[0] || '',
        price,
        image,
        sourceUrl: card?.href || ''
      };
    }))()`);
    if (Array.isArray(cards) && cards.length >= 10) return cards;
    await delay(1200);
  }
  throw new Error("等待 1688 卡片超时");
}

async function api(pathname, init = {}) {
  const response = await fetch(`${APP_BASE}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || !payload?.success) throw new Error(payload?.error?.message || `${pathname} 请求失败`);
  return payload.data;
}

function repairedScrapedData(item, card) {
  const data = asRecord(item.scrapedData);
  const existingVariant = chooseSingleVariant(data);
  const skuId = variantId(existingVariant || {}) || `${card.offerId}-default`;
  const price = textValue(existingVariant?.price) || card.price || textValue(item.costPrice);
  const variant = existingVariant || {
    skuId,
    sourceSkuId: skuId,
    specText: "默认款",
    sourceSpecText: "默认款",
    price,
    stock: "999",
  };
  const existingImages = Array.isArray(data.images) ? data.images.map(textValue).filter(Boolean) : [];
  const images = Array.from(new Set([card.image, ...existingImages].filter(Boolean)));
  const workflow = asRecord(data.workflowImages);
  const workflowItems = Array.isArray(workflow.items) && workflow.items.length
    ? workflow.items
    : images.map((url, index) => ({
        id: `card-${card.offerId}-${index + 1}`,
        name: `1688-${card.offerId}-${index + 1}.jpg`,
        url,
        selected: index === 0,
        isPrimary: index === 0,
      }));
  return {
    ...data,
    title: card.title,
    offerId: card.offerId,
    sourceUrl: card.sourceUrl || item.sourceUrl,
    imageUrl: card.image || item.imageUrl,
    images,
    gallery: images,
    variants: [variant],
    rawVariants: [variant],
    selectedVariant: variant,
    skuSelection: {
      mode: "multiple",
      selectedSkuIds: [skuId],
      selectedCount: 1,
      totalCount: 1,
    },
    workflowImages: {
      ...workflow,
      items: workflowItems,
      primaryImageId: textValue(workflow.primaryImageId) || textValue(asRecord(workflowItems[0]).id),
      selectedImageIds: Array.isArray(workflow.selectedImageIds) && workflow.selectedImageIds.length
        ? workflow.selectedImageIds
        : [textValue(asRecord(workflowItems[0]).id)].filter(Boolean),
    },
    collectionRepair: {
      source: "1688_search_card",
      repairedAt: new Date().toISOString(),
    },
  };
}

async function main() {
  const manifest = await readJsonFile(MANIFEST_PATH, []);
  const wanted = new Set(manifest.map((entry) => String(entry.offerId)));
  const cdp = await connect();
  const metadata = [];
  try {
    for (let page = 1; page <= 12 && metadata.length < wanted.size; page += 1) {
      const url = `https://s.1688.com/page/pccps.html?keywords=${encodeURIComponent("宠物玩具")}&charset=utf8&beginPage=${page}#banana-1688-search`;
      await cdp.call("Page.navigate", { url });
      const cards = await readCards(cdp);
      for (const card of cards) {
        if (wanted.has(String(card.offerId)) && !metadata.some((entry) => entry.offerId === card.offerId)) {
          metadata.push(card);
        }
      }
      process.stdout.write(`page=${page} metadata=${metadata.length}/${wanted.size}\n`);
    }
  } finally {
    cdp.socket.close();
  }
  await writeJsonAtomic(METADATA_PATH, metadata);
  const items = await api("/api/listing-workflow/items");
  const itemByOffer = new Map(items.map((item) => [String(item.offerId), item]));
  let repaired = 0;
  for (const card of metadata) {
    const item = itemByOffer.get(String(card.offerId));
    if (!item || !card.title || !card.image || !card.price) continue;
    const data = asRecord(item.scrapedData);
    const genericTitle = /^1688 商品 \d+$/.test(String(item.title || ""));
    const missingVariant = !variantId(chooseSingleVariant(data) || {});
    if (!genericTitle && !missingVariant) continue;
    await api(`/api/listing-workflow/items/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: card.title,
        imageUrl: card.image,
        costPrice: card.price,
        currentPrice: card.price,
        scrapedData: repairedScrapedData(item, card),
      }),
    });
    repaired += 1;
  }
  await fs.writeFile(
    path.resolve("storage/pet-toy-batch/card-repair-summary.json"),
    `${JSON.stringify({ metadata: metadata.length, repaired, completedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ metadata: metadata.length, repaired }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
