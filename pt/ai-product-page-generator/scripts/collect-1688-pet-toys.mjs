#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { readJsonFile, writeJsonAtomic } from "./lib/pet-toy-batch.mjs";

function parseArgs(argv) {
  const args = {
    cdpBase: "http://127.0.0.1:9222",
    appBase: "http://127.0.0.1:3000",
    startPage: 1,
    maxPages: 12,
    target: 110,
    perItemTimeoutMs: 120_000,
    progress: "storage/pet-toy-batch/collection-progress.json",
    manifest: "storage/pet-toy-batch/sources.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--cdp-base") args.cdpBase = argv[++index];
    else if (token === "--app-base") args.appBase = argv[++index];
    else if (token === "--start-page") args.startPage = Number(argv[++index]);
    else if (token === "--max-pages") args.maxPages = Number(argv[++index]);
    else if (token === "--target") args.target = Number(argv[++index]);
    else if (token === "--progress") args.progress = argv[++index];
    else if (token === "--manifest") args.manifest = argv[++index];
    else throw new Error(`未知参数：${token}`);
  }
  return args;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToSearchPage(cdpBase) {
  const targets = await fetch(`${cdpBase}/json/list`).then((response) => response.json());
  const target = targets.find(
    (entry) =>
      entry.type === "page" &&
      String(entry.url || "").includes("s.1688.com/page/pccps.html"),
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("9222 浏览器中没有 1688 宠物玩具搜索页。");
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 1688 CDP 超时")), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    if (!payload.id || !pending.has(payload.id)) return;
    const { resolve, reject, timer } = pending.get(payload.id);
    pending.delete(payload.id);
    clearTimeout(timer);
    if (payload.error) reject(new Error(payload.error.message));
    else resolve(payload.result);
  });
  const call = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    }
    return result.result?.value;
  };
  return { socket, call, evaluate };
}

async function waitForCollectors(cdp, minCount = 10) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const cards = await cdp.evaluate(`(() => [...document.querySelectorAll('.banana-mall-1688-card-collector')].map((node) => ({
      offerId: node.dataset.offerId || '',
      state: node.dataset.state || '',
      text: node.innerText || '',
      sourceUrl: node.closest('a[href]')?.href || ''
    })))()`);
    if (Array.isArray(cards) && cards.length >= minCount) return cards;
    await delay(1500);
  }
  throw new Error("1688 搜索卡片或采集扩展加载超时。");
}

async function clickAndWait(cdp, offerId, timeoutMs) {
  const clicked = await cdp.evaluate(`(() => {
    const node = [...document.querySelectorAll('.banana-mall-1688-card-collector')]
      .find((entry) => entry.dataset.offerId === ${JSON.stringify(offerId)});
    const button = node?.querySelector('button');
    if (!node || !button) return false;
    if (node.dataset.state === 'done') return true;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`页面未找到 offerId=${offerId} 的采集按钮`);

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => {
      const node = [...document.querySelectorAll('.banana-mall-1688-card-collector')]
        .find((entry) => entry.dataset.offerId === ${JSON.stringify(offerId)});
      return node ? { state: node.dataset.state || '', text: node.innerText || '' } : null;
    })()`);
    if (last?.state === "done") return last;
    if (last?.state === "error") throw new Error(last.text || "扩展采集失败");
    await delay(1500);
  }
  throw new Error(`offerId=${offerId} 采集超时：${last?.text || "无状态"}`);
}

async function buildManifest(args, progress) {
  const response = await fetch(`${args.appBase}/api/listing-workflow/items`, {
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || !payload?.success || !Array.isArray(payload.data)) {
    throw new Error(payload?.error?.message || "读取本地采集商品失败");
  }
  const successful = new Map(
    progress.offers
      .filter((entry) => entry.status === "done")
      .map((entry) => [String(entry.offerId), entry]),
  );
  const manifest = payload.data
    .filter((item) => successful.has(String(item.offerId)))
    .sort((left, right) => {
      const leftAt = successful.get(String(left.offerId))?.completedAt || "";
      const rightAt = successful.get(String(right.offerId))?.completedAt || "";
      return leftAt.localeCompare(rightAt);
    })
    .map((item) => ({
      workflowItemId: item.id,
      offerId: item.offerId,
      sourceUrl: item.sourceUrl,
    }));
  await writeJsonAtomic(path.resolve(args.manifest), manifest);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const progressPath = path.resolve(args.progress);
  const existing = await readJsonFile(progressPath, null);
  const progress = existing || {
    version: 1,
    keyword: "宠物玩具",
    createdAt: new Date().toISOString(),
    offers: [],
  };
  const known = new Map(progress.offers.map((entry) => [String(entry.offerId), entry]));
  const completedCount = () => progress.offers.filter((entry) => entry.status === "done").length;
  const cdp = await connectToSearchPage(args.cdpBase);
  try {
    for (
      let page = args.startPage;
      page < args.startPage + args.maxPages && completedCount() < args.target;
      page += 1
    ) {
      const pageUrl = `https://s.1688.com/page/pccps.html?keywords=${encodeURIComponent("宠物玩具")}&charset=utf8&beginPage=${page}#banana-1688-search`;
      await cdp.call("Page.navigate", { url: pageUrl });
      const cards = await waitForCollectors(cdp);
      process.stdout.write(`[${new Date().toISOString()}] page=${page} cards=${cards.length}\n`);
      for (const card of cards) {
        if (completedCount() >= args.target) break;
        const offerId = String(card.offerId || "");
        if (!offerId) continue;
        const prior = known.get(offerId);
        if (prior?.status === "done") continue;
        const entry = prior || {
          offerId,
          page,
          sourceUrl: card.sourceUrl,
          attempts: 0,
        };
        entry.attempts += 1;
        entry.status = "running";
        entry.startedAt = new Date().toISOString();
        if (!prior) {
          progress.offers.push(entry);
          known.set(offerId, entry);
        }
        await writeJsonAtomic(progressPath, progress);
        try {
          const result = await clickAndWait(cdp, offerId, args.perItemTimeoutMs);
          entry.status = "done";
          entry.message = result.text;
          entry.completedAt = new Date().toISOString();
          entry.error = null;
          process.stdout.write(`[${entry.completedAt}] ${offerId} done (${completedCount()}/${args.target})\n`);
        } catch (error) {
          entry.status = "failed";
          entry.error = error instanceof Error ? error.message : String(error);
          entry.completedAt = new Date().toISOString();
          process.stdout.write(`[${entry.completedAt}] ${offerId} failed: ${entry.error}\n`);
        }
        await writeJsonAtomic(progressPath, progress);
      }
    }
  } finally {
    cdp.socket.close();
  }
  const manifest = await buildManifest(args, progress);
  process.stdout.write(`${JSON.stringify({ completed: completedCount(), manifest: manifest.length, manifestPath: path.resolve(args.manifest) }, null, 2)}\n`);
  if (manifest.length < 100) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
