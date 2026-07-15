#!/usr/bin/env node

import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SERVER_URL = (process.env.RELAY_SERVER_URL || "http://35.209.87.105").replace(/\/+$/, "");
const AGENT_TOKEN = String(process.env.RELAY_MVP_AGENT_TOKEN || "").trim();
const AGENT_ID = String(process.env.RELAY_AGENT_ID || `${os.hostname()}-${process.pid}`).slice(0, 100);
const MODE = String(process.env.RELAY_AGENT_MODE || "echo").toLowerCase();
const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const POLL_MS = Math.max(250, Number(process.env.RELAY_POLL_MS || 800));
const WEB_AI_ROOT = process.env.WEB_AI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../ai");
const VERSION = "0.1.0";

if (!AGENT_TOKEN) {
  console.error("缺少 RELAY_MVP_AGENT_TOKEN");
  process.exit(1);
}

let stopped = false;
let browserPromise = null;
let chatPage = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, body, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVER_URL}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function connectChrome() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const require = createRequire(path.join(WEB_AI_ROOT, "package.json"));
    const { chromium } = require("playwright-core");
    const browser = await chromium.connectOverCDP(CDP_URL);
    browser.on("disconnected", () => {
      browserPromise = null;
      chatPage = null;
    });
    return browser;
  })();
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

async function getChatPage() {
  if (chatPage && !chatPage.isClosed()) return chatPage;
  let browser = await connectChrome();
  let contexts = browser.contexts();
  if (!contexts.length) {
    browserPromise = null;
    chatPage = null;
    browser = await connectChrome();
    contexts = browser.contexts();
  }
  if (!contexts.length) throw new Error("9222 Chrome 没有可用浏览器上下文");
  for (const page of contexts[0].pages()) {
    if (/https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(page.url())) {
      chatPage = page;
      break;
    }
  }
  if (!chatPage) {
    chatPage = await contexts[0].newPage();
    await chatPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await chatPage.bringToFront();
  return chatPage;
}

async function runChatGpt(message) {
  const page = await getChatPage();
  const prompt = page.locator("#prompt-textarea");
  try {
    await prompt.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    throw new Error(`GPT页面尚未登录或输入框不可用，当前地址：${page.url()}`);
  }

  const assistantMessages = page.locator('[data-message-author-role="assistant"]');
  const beforeCount = await assistantMessages.count();
  await prompt.fill(message);
  const sendButton = page.locator('button[data-testid="send-button"]');
  if ((await sendButton.count()) === 1) await sendButton.click();
  else await prompt.press("Enter");

  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-message-author-role="assistant"]').length > count,
    beforeCount,
    { timeout: 120_000 },
  );

  let lastText = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const count = await assistantMessages.count();
    if (count > beforeCount) {
      const text = (await assistantMessages.nth(count - 1).innerText()).trim();
      if (text && text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      }
      const stopVisible = await page.locator('button[data-testid="stop-button"]').isVisible().catch(() => false);
      if (lastText && !stopVisible && Date.now() - stableSince >= 1_200) return lastText;
    }
    await delay(400);
  }
  if (lastText) return lastText;
  throw new Error("等待 GPT 回复超时");
}

async function handleTask(task) {
  if (MODE === "echo") {
    await delay(120);
    return `本机 Agent 已收到并返回：${task.message}`;
  }
  if (MODE === "chatgpt") return runChatGpt(task.message);
  throw new Error(`不支持的 Agent 模式：${MODE}`);
}

async function loop() {
  console.log(JSON.stringify({ event: "agent_started", server: SERVER_URL, agentId: AGENT_ID, mode: MODE }));
  let failures = 0;
  while (!stopped) {
    try {
      const pulled = await api("/api/relay-mvp/agent/pull", {
        agentId: AGENT_ID,
        mode: MODE,
        version: VERSION,
      });
      failures = 0;
      if (!pulled.task) {
        await delay(POLL_MS);
        continue;
      }

      const startedAt = Date.now();
      const task = pulled.task;
      console.log(JSON.stringify({ event: "task_claimed", taskId: task.id }));
      try {
        const response = await handleTask(task);
        const processingMs = Date.now() - startedAt;
        await api("/api/relay-mvp/agent/result", {
          taskId: task.id,
          agentId: AGENT_ID,
          status: "completed",
          response,
          processingMs,
        });
        console.log(JSON.stringify({ event: "task_completed", taskId: task.id, processingMs }));
      } catch (error) {
        const processingMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        await api("/api/relay-mvp/agent/result", {
          taskId: task.id,
          agentId: AGENT_ID,
          status: "failed",
          error: message,
          processingMs,
        });
        console.error(JSON.stringify({ event: "task_failed", taskId: task.id, error: message }));
      }
    } catch (error) {
      failures += 1;
      const waitMs = Math.min(10_000, 500 * 2 ** Math.min(failures, 5));
      console.error(JSON.stringify({ event: "relay_error", error: error instanceof Error ? error.message : String(error), retryMs: waitMs }));
      await delay(waitMs);
    }
  }
}

process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

await loop();
