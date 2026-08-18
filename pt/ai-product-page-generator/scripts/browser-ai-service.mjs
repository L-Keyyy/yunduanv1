import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import path from "path";
import { pathToFileURL } from "url";

const CORE_ROOT = process.env.BROWSER_AI_CORE_ROOT || process.cwd();
const HOST = process.env.BROWSER_AI_SERVICE_HOST || "127.0.0.1";
const PORT = Number(process.env.BROWSER_AI_SERVICE_PORT || 3101);
const DOUBAO_WEB_SERVICE_URL = (process.env.DOUBAO_WEB_SERVICE_URL || "http://127.0.0.1:8010").replace(/\/+$/, "");
const CHROME_DEVTOOLS_BASE = (process.env.CHROME_DEVTOOLS_BASE || "http://127.0.0.1:9222").replace(/\/+$/, "");
const INPUT_ROOT = path.join(CORE_ROOT, "data", "banana-mall-inputs");
const MAX_BODY_SIZE = 40 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 4;
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const FILE_EXTENSIONS = new Set([".json", ".db", ".sqlite", ".sqlite3"]);
const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const DOUBAO_MODELS = [
  { id: "doubao-web", object: "model", owned_by: "doubao_text", type: "text" },
  { id: "doubao-image-web", object: "model", owned_by: "doubao", type: "image" },
];

const MODEL_ALIASES = {
  "doubao-web": "seed",
  "doubao-image-web": "seedream-4.5",
};

const DEFAULT_MODELS = [
  { id: "gpt-instant", object: "model", owned_by: "chatgpt_text", type: "text" },
  { id: "gpt-thinking", object: "model", owned_by: "chatgpt_text", type: "text" },
  { id: "gpt-pro", object: "model", owned_by: "chatgpt_text", type: "text" },
  { id: "gpt-image-1.5", object: "model", owned_by: "chatgpt", type: "image" },
  ...DOUBAO_MODELS,
];

let backend = null;
let cleanupBrowser = null;
let preflight = null;
let registry = null;
let coreLoadPromise = null;
let poolContext = null;
let runtimeStatus = "idle";
let runtimeMessage = "浏览器服务已启动；首次生成时加载浏览器核心";
let startPromise = null;
const queueTails = new Map();

async function readChromeCookiesForDomain(domain) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${CHROME_DEVTOOLS_BASE}/json/list`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const pages = await response.json();
    const target = Array.isArray(pages)
      ? (
        pages.find((page) =>
          page?.type === "page" &&
          String(page?.url || "").includes(domain) &&
          page?.webSocketDebuggerUrl
        ) ||
        pages.find((page) => page?.type === "page" && page?.webSocketDebuggerUrl)
      )
      : null;
    if (!target?.webSocketDebuggerUrl) return [];

    return await new Promise((resolve) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      const callId = 1;
      const socketTimeout = setTimeout(() => {
        socket.close();
        resolve([]);
      }, 5000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: callId, method: "Network.getAllCookies" }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data || ""));
          if (payload.id !== callId) return;
          clearTimeout(socketTimeout);
          socket.close();
          const cookies = Array.isArray(payload.result?.cookies)
            ? payload.result.cookies
            : [];
          resolve(cookies.filter((cookie) =>
            String(cookie.domain || "").replace(/^\./, "").endsWith(domain)
          ));
        } catch {
          // 等待下一条 CDP 消息。
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(socketTimeout);
        resolve([]);
      });
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function playwrightCookies(cookies) {
  return cookies.flatMap((cookie) => {
    const name = String(cookie.name || "");
    const value = String(cookie.value || "");
    const domain = String(cookie.domain || "");
    if (!name || !domain) return [];
    const result = {
      name,
      value,
      domain,
      path: String(cookie.path || "/"),
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite)
        ? cookie.sameSite
        : "Lax",
    };
    if (Number(cookie.expires) > 0) result.expires = Number(cookie.expires);
    return [result];
  });
}

async function syncDoubaoLoginToCamoufox(context) {
  const workers = context?.poolManager?.workers?.filter((worker) =>
    worker.type === "doubao" ||
    worker.type === "doubao_text" ||
    (worker.type === "merge" &&
      (worker.mergeTypes || []).some((type) => type === "doubao" || type === "doubao_text"))
  ) || [];
  if (!workers.length) return;
  const cookies = playwrightCookies(await readChromeCookiesForDomain("doubao.com"));
  if (!cookies.length) {
    console.warn("[browser-ai-service] 9222 Chrome 中未读取到豆包会话 Cookie");
    return;
  }
  await workers[0].browser.addCookies(cookies);
  await Promise.all(workers.map(async (worker) => {
    await worker.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 })
      .catch(() => undefined);
  }));
  console.log(`[browser-ai-service] 已将 ${cookies.length} 个豆包会话 Cookie 同步到 Camoufox`);
}

async function syncChatgptLoginToCamoufox(context) {
  const workers = context?.poolManager?.workers?.filter((worker) =>
    worker.type === "chatgpt" ||
    worker.type === "chatgpt_text" ||
    (worker.type === "merge" &&
      (worker.mergeTypes || []).some((type) => type === "chatgpt" || type === "chatgpt_text"))
  ) || [];
  if (!workers.length) return;
  const cookies = playwrightCookies([
    ...await readChromeCookiesForDomain("chatgpt.com"),
    ...await readChromeCookiesForDomain("openai.com"),
  ]);
  if (!cookies.length) return;
  await workers[0].browser.addCookies(cookies);
  await Promise.all(workers.map(async (worker) => {
    await worker.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 })
      .catch(() => undefined);
  }));
  console.log(`[browser-ai-service] 已将 ${cookies.length} 个 ChatGPT 会话 Cookie 同步到 Camoufox`);
}

async function syncLoginForModel(context, modelId) {
  const adapterType = adapterTypeForModel(modelId);
  if (adapterType === "chatgpt" || adapterType === "chatgpt_text") {
    await syncChatgptLoginToCamoufox(context);
  } else if (adapterType === "doubao" || adapterType === "doubao_text") {
    await syncDoubaoLoginToCamoufox(context);
  }
}

function configuredAdapterTypes() {
  if (!backend) return [];
  const workers = backend.config.backend?.pool?.workers || [];
  return workers.flatMap((worker) =>
    worker.type === "merge" ? worker.mergeTypes || [] : [worker.type],
  );
}

function configuredModels() {
  if (!registry) return DEFAULT_MODELS;
  const seen = new Set();
  const models = [];
  for (const type of configuredAdapterTypes()) {
    // 豆包在商品系统中保留稳定别名，内部具体模型由 MODEL_ALIASES 路由。
    if (type === "doubao" || type === "doubao_text") continue;
    const adapterModels = registry.getModelsForAdapter(type)?.data || [];
    for (const model of adapterModels) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({
        ...model,
        owned_by: type,
      });
    }
  }
  for (const model of DOUBAO_MODELS) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.length ? models : DEFAULT_MODELS;
}

let models = DEFAULT_MODELS;

async function loadCore() {
  if (backend && registry && preflight) return;
  if (coreLoadPromise) return coreLoadPromise;

  coreLoadPromise = (async () => {
    runtimeStatus = "loading";
    runtimeMessage = "正在加载浏览器模型依赖";
    const [backendModule, launcherModule, preflightModule, registryModule] = await Promise.all([
      import(pathToFileURL(path.join(CORE_ROOT, "src/backend/index.js")).href),
      import(pathToFileURL(path.join(CORE_ROOT, "src/backend/engine/launcher.js")).href),
      import(pathToFileURL(path.join(CORE_ROOT, "src/server/preflight.js")).href),
      import(pathToFileURL(path.join(CORE_ROOT, "src/backend/registry.js")).href),
    ]);
    backend = backendModule.getBackend();
    cleanupBrowser = launcherModule.cleanup;
    preflight = preflightModule.preflight;
    registry = registryModule.registry;
    await registry.loadAll();
    registry.setAdapterConfig(backend.config.backend?.adapter || {});
    models = configuredModels();
    runtimeStatus = "idle";
    runtimeMessage = `模型已载入，共 ${models.length} 个；浏览器核心尚未启动`;
  })();

  try {
    await coreLoadPromise;
  } catch (error) {
    runtimeStatus = "error";
    runtimeMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    coreLoadPromise = null;
  }
}

process.on("uncaughtException", (error) => {
  console.error("[browser-ai-service] uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[browser-ai-service] unhandledRejection", reason);
});

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function parseBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function materializeImages(images = []) {
  if (!Array.isArray(images)) throw new Error("images 必须是数组");
  if (images.length > MAX_IMAGES) throw new Error(`最多上传 ${MAX_IMAGES} 张图片`);
  if (!images.length) return { directory: null, paths: [] };

  const directory = path.join(INPUT_ROOT, crypto.randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const paths = [];
  try {
    for (let index = 0; index < images.length; index += 1) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(
        String(images[index] || ""),
      );
      if (!match) throw new Error(`第 ${index + 1} 张参考图格式无效`);
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (!bytes.length || bytes.length > MAX_IMAGE_SIZE) {
        throw new Error(`第 ${index + 1} 张参考图大小必须在 1B 到 10MB 之间`);
      }
      const filePath = path.join(directory, `${index + 1}${IMAGE_EXTENSIONS[match[1]]}`);
      await fs.writeFile(filePath, bytes);
      paths.push(filePath);
    }
    return { directory, paths };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function validatedFilePaths(files = []) {
  if (!Array.isArray(files)) throw new Error("files 必须是数组");
  if (files.length > MAX_FILES) throw new Error(`最多上传 ${MAX_FILES} 个附件`);
  const paths = [];
  for (let index = 0; index < files.length; index += 1) {
    const filePath = path.resolve(String(files[index] || ""));
    const extension = path.extname(filePath).toLowerCase();
    if (!FILE_EXTENSIONS.has(extension)) {
      throw new Error(`第 ${index + 1} 个附件类型应为 JSON 或 SQLite`);
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_SIZE) {
      throw new Error(`第 ${index + 1} 个附件大小应在 1B 到 512MB 之间`);
    }
    paths.push(filePath);
  }
  return paths;
}

async function ensureRuntime() {
  if (poolContext) return poolContext;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    await loadCore();
    runtimeStatus = "starting";
    runtimeMessage = "正在启动有头浏览器核心";
    const check = preflight();
    if (!check.ok) throw new Error(check.errors.join("；"));
    poolContext = await backend.initBrowser(backend.config);
    runtimeStatus = "ready";
    runtimeMessage = `浏览器核心已就绪，共 ${models.length} 个模型`;
    return poolContext;
  })();

  try {
    return await startPromise;
  } catch (error) {
    runtimeStatus = "error";
    runtimeMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    startPromise = null;
  }
}

async function generate(input) {
  const modelId = String(input.modelId || "").trim();
  const prompt = String(input.prompt || "").trim();
  if (!modelId) throw new Error("请选择浏览器模型");
  if (!prompt) throw new Error("提示词不能为空");
  await loadCore();
  if (!models.some((model) => model.id === modelId)) {
    throw new Error(`当前 WebAI2API 配置不支持模型：${modelId}`);
  }
  const routedModelId = MODEL_ALIASES[modelId] || modelId;

  const materialized = await materializeImages(input.images);
  const filePaths = await validatedFilePaths(input.files);
  try {
    const context = await ensureRuntime();
    // 9222 可能在服务运行期间被替换；每次任务前重新读取当前临时浏览器会话。
    await syncLoginForModel(context, modelId);
    const result = await backend.generate(
      context,
      prompt,
      [...materialized.paths, ...filePaths],
      routedModelId,
      { source: "banana-mall", requestId: crypto.randomUUID() },
    );
    if (result?.error) throw new Error(result.error);
    return result;
  } finally {
    if (materialized.directory) {
      await fs.rm(materialized.directory, { recursive: true, force: true });
    }
  }
}

function adapterTypeForModel(modelId) {
  const configured = models.find((model) => model.id === modelId);
  if (configured?.owned_by) return configured.owned_by;
  if (modelId.startsWith("doubao")) {
    return modelId.includes("image") ? "doubao" : "doubao_text";
  }
  if (modelId.startsWith("gpt")) {
    return modelId.includes("image") ? "chatgpt" : "chatgpt_text";
  }
  return modelId;
}

function queueKeyForInput(input) {
  const modelId = String(input.modelId || "").trim();
  const adapterType = adapterTypeForModel(modelId);
  const workers = backend?.config?.backend?.pool?.workers || [];
  const worker = workers.find((candidate) =>
    candidate.type === adapterType ||
    (candidate.type === "merge" &&
      (candidate.mergeTypes || []).includes(adapterType))
  );
  return worker?.name ? `worker:${worker.name}` : `adapter:${adapterType}`;
}

async function enqueue(input) {
  await loadCore();
  const queueKey = queueKeyForInput(input);
  const previousTail = queueTails.get(queueKey) || Promise.resolve();
  const task = previousTail.then(() => generate(input));
  const nextTail = task.catch(() => undefined);
  queueTails.set(queueKey, nextTail);
  nextTail.finally(() => {
    if (queueTails.get(queueKey) === nextTail) queueTails.delete(queueKey);
  });
  return task;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, {
        ok: true,
        runtime: {
          status: runtimeStatus,
          message: runtimeMessage,
        },
        models,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/generate") {
      const input = await parseBody(request);
      const result = await enqueue(input);
      sendJson(response, 200, { ok: true, result });
      return;
    }

    sendJson(response, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST);
server.on("listening", () => {
  console.log(`[browser-ai-service] listening on http://${HOST}:${PORT}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  try {
    if (poolContext && cleanupBrowser) await cleanupBrowser();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
