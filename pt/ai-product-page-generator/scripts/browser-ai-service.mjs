import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import path from "path";
import { pathToFileURL } from "url";

const CORE_ROOT = process.env.BROWSER_AI_CORE_ROOT || process.cwd();
const HOST = process.env.BROWSER_AI_SERVICE_HOST || "127.0.0.1";
const PORT = Number(process.env.BROWSER_AI_SERVICE_PORT || 3101);
const INPUT_ROOT = path.join(CORE_ROOT, "data", "banana-mall-inputs");
const MAX_BODY_SIZE = 40 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const [{ getBackend }, { cleanup: cleanupBrowser }, { preflight }, { registry }] = await Promise.all([
  import(pathToFileURL(path.join(CORE_ROOT, "src/backend/index.js")).href),
  import(pathToFileURL(path.join(CORE_ROOT, "src/backend/engine/launcher.js")).href),
  import(pathToFileURL(path.join(CORE_ROOT, "src/server/preflight.js")).href),
  import(pathToFileURL(path.join(CORE_ROOT, "src/backend/registry.js")).href),
]);

const backend = getBackend();
let poolContext = null;
let runtimeStatus = "idle";
let runtimeMessage = "模型已载入，浏览器核心尚未启动";
let startPromise = null;
let queueTail = Promise.resolve();

await registry.loadAll();
registry.setAdapterConfig(backend.config.backend?.adapter || {});

function configuredAdapterTypes() {
  const workers = backend.config.backend?.pool?.workers || [];
  return workers.flatMap((worker) =>
    worker.type === "merge" ? worker.mergeTypes || [] : [worker.type],
  );
}

function configuredModels() {
  const seen = new Set();
  const models = [];
  for (const type of configuredAdapterTypes()) {
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
  return models;
}

const models = configuredModels();

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

async function ensureRuntime() {
  if (poolContext) return poolContext;
  if (startPromise) return startPromise;

  startPromise = (async () => {
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
  if (!models.some((model) => model.id === modelId)) {
    throw new Error(`当前 WebAI2API 配置不支持模型：${modelId}`);
  }

  const materialized = await materializeImages(input.images);
  try {
    const context = await ensureRuntime();
    const result = await backend.generate(
      context,
      prompt,
      materialized.paths,
      modelId,
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

function enqueue(input) {
  const task = queueTail.then(() => generate(input));
  queueTail = task.catch(() => undefined);
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

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  try {
    if (poolContext) await cleanupBrowser();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
