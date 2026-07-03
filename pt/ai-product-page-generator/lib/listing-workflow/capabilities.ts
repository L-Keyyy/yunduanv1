import { access } from "fs/promises";
import path from "path";

export type WorkflowCapability = {
  id: "crawler" | "ai" | "ozon" | "ocr";
  label: string;
  ready: boolean;
  summary: string;
  baseDir: string | null;
  files: Array<{ label: string; path: string; exists: boolean }>;
  endpoint?: string;
};

export type ListingWorkflowCapabilities = {
  workspaceRoot: string;
  capabilities: WorkflowCapability[];
};

function workspaceRoot() {
  return path.resolve(process.cwd(), "../..");
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function fileEntry(baseDir: string, label: string, relativePath: string) {
  const filePath = path.join(baseDir, relativePath);
  return {
    label,
    path: filePath,
    exists: await exists(filePath),
  };
}

function allReady(files: Array<{ exists: boolean }>) {
  return files.length > 0 && files.every((file) => file.exists);
}

async function endpointReady(endpoint: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanListingWorkflowCapabilities(): Promise<ListingWorkflowCapabilities> {
  const root = workspaceRoot();
  const crawlerDir = path.join(root, "MarketSpider-main");
  const imageWorkshopDir = path.join(root, "pt", "image-workshop");
  const ozonDir = path.join(root, "OZON_HD");
  const aiServiceDir = path.join(process.cwd(), "lib", "services");
  const ocrEndpoint = "http://127.0.0.1:8010";

  const crawlerFiles = await Promise.all([
    fileEntry(crawlerDir, "淘宝爬虫", "Spider_taobao.py"),
    fileEntry(crawlerDir, "京东爬虫", "Spider_jd.py"),
    fileEntry(crawlerDir, "1688 爬虫", "1688Spider.py"),
    fileEntry(crawlerDir, "采集控制台", "MarketSpider_WebUI.py"),
  ]);

  const ocrFiles = await Promise.all([
    fileEntry(imageWorkshopDir, "OCR 翻译接口", "backend/app.py"),
    fileEntry(imageWorkshopDir, "图片文字处理器", "backend/image_workshop_processor.py"),
    fileEntry(imageWorkshopDir, "图片工作台页面", "frontend/index.html"),
  ]);
  const ocrFilesReady = allReady(ocrFiles);
  const ocrServiceReady = ocrFilesReady ? await endpointReady(ocrEndpoint) : false;

  const ozonFiles = await Promise.all([
    fileEntry(ozonDir, "统一清洗入口", "index.js"),
    fileEntry(ozonDir, "Ozon 属性匹配", "attribute_matcher.js"),
    fileEntry(ozonDir, "图片下载", "image_downloader.js"),
    fileEntry(ozonDir, "Ozon 上传", "upload.js"),
    fileEntry(ozonDir, "后台收集接口", "server/routes.js"),
  ]);

  const aiFiles = await Promise.all([
    fileEntry(aiServiceDir, "AI Provider 配置", "provider-service.ts"),
    fileEntry(aiServiceDir, "结构化生成服务", "generation-service.ts"),
    fileEntry(aiServiceDir, "图片生成/编辑服务", "xiaohongshu-service.ts"),
  ]);

  return {
    workspaceRoot: root,
    capabilities: [
      {
        id: "crawler",
        label: "链接采集",
        ready: allReady(crawlerFiles),
        summary: "淘宝、京东、1688 爬虫聚合入口，负责把商品链接采集成 JSON。",
        baseDir: crawlerDir,
        files: crawlerFiles,
      },
      {
        id: "ai",
        label: "AI 字段理解",
        ready: allReady(aiFiles),
        summary: "把爬虫 JSON 交给 AI，抽取商品名、卖点、规格，并生成 Ozon 特征草稿。",
        baseDir: aiServiceDir,
        files: aiFiles,
      },
      {
        id: "ocr",
        label: "附图 OCR 翻译",
        ready: ocrFilesReady && ocrServiceReady,
        summary: ocrServiceReady
          ? "OCR 服务在线，可识别附图文字并翻译回填。"
          : ocrFilesReady
            ? "OCR 文件已就绪，但 8010 服务未启动。"
            : "未找到完整 OCR 模块文件。",
        baseDir: imageWorkshopDir,
        files: ocrFiles,
        endpoint: ocrEndpoint,
      },
      {
        id: "ozon",
        label: "Ozon 清洗上传",
        ready: allReady(ozonFiles),
        summary: "匹配 Ozon 类目和必填特征，生成 /v3/product/import 数据并上传后台。",
        baseDir: ozonDir,
        files: ozonFiles,
      },
    ],
  };
}
