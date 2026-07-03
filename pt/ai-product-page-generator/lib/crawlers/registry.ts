import { spawn } from "child_process";
import { access, readdir, stat } from "fs/promises";
import path from "path";

export type CrawlerStatus = "ready" | "partial" | "missing";

export type CrawlerOutputFile = {
  name: string;
  path: string;
  modifiedAt: string;
  size: number;
};

export type CrawlerModule = {
  id: string;
  label: string;
  source: string;
  status: CrawlerStatus;
  baseDir: string;
  description: string;
  scripts: Array<{ label: string; path: string; exists: boolean }>;
  outputs: Array<{ label: string; path: string; count: number; latest: CrawlerOutputFile[] }>;
  actions: Array<{ id: string; label: string; enabled: boolean }>;
};

export type CrawlerScanResult = {
  workspaceRoot: string;
  modules: CrawlerModule[];
};

export type CrawlerLaunchResult = {
  url: string | null;
  message: string;
  action: string;
};

const MARKETSPIDER_UI_URL = "http://127.0.0.1:8766/";

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

async function recentFiles(dir: string, limit = 5) {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  const files: CrawlerOutputFile[] = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({
      name: entry,
      path: filePath,
      modifiedAt: info.mtime.toISOString(),
      size: info.size,
    });
  }

  return files.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt)).slice(0, limit);
}

async function outputSummary(label: string, dir: string) {
  const latest = await recentFiles(dir);
  const count = (await exists(dir)) ? (await readdir(dir)).length : 0;

  return {
    label,
    path: dir,
    count,
    latest,
  };
}

async function scriptEntry(baseDir: string, label: string, relativePath: string) {
  const scriptPath = path.join(baseDir, relativePath);
  return {
    label,
    path: scriptPath,
    exists: await exists(scriptPath),
  };
}

function statusFromScripts(required: Array<{ exists: boolean }>) {
  if (required.every((item) => item.exists)) return "ready";
  if (required.some((item) => item.exists)) return "partial";
  return "missing";
}

function terminalCommand(command: string) {
  if (process.platform === "darwin") {
    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${escaped}"`], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "MarketSpider", "cmd", "/k", command], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  spawn(command, { shell: true, detached: true, stdio: "ignore" }).unref();
}

async function probeMarketSpiderUi(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(new URL("/api/status", url), {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function scanCrawlerModules(): Promise<CrawlerScanResult> {
  const root = workspaceRoot();
  const marketSpiderDir = path.join(root, "MarketSpider-main");
  const marketSpiderPtDir = path.join(root, "pt", "MarketSpider-main");

  const marketSpiderScripts = await Promise.all([
    scriptEntry(marketSpiderDir, "控制台 UI", "MarketSpider_WebUI.py"),
    scriptEntry(marketSpiderDir, "淘宝", "Spider_taobao.py"),
    scriptEntry(marketSpiderDir, "京东", "Spider_jd.py"),
    scriptEntry(marketSpiderDir, "1688", "1688Spider.py"),
    scriptEntry(marketSpiderDir, "Cookie", "GetCookie.py"),
  ]);

  const marketSpiderPtScripts = await Promise.all([
    scriptEntry(marketSpiderPtDir, "淘宝", "Spider_taobao.py"),
    scriptEntry(marketSpiderPtDir, "京东", "Spider_jd.py"),
    scriptEntry(marketSpiderPtDir, "1688", "1688Spider.py"),
    scriptEntry(marketSpiderPtDir, "Cookie", "GetCookie.py"),
  ]);

  return {
    workspaceRoot: root,
    modules: [
      {
        id: "marketspider-main",
        label: "淘宝 / 京东 / 1688 采集控制台",
        source: "MarketSpider-main",
        status: statusFromScripts(marketSpiderScripts),
        baseDir: marketSpiderDir,
        description: "搜索电商平台商品，导出链接、价格、店铺和标题数据。",
        scripts: marketSpiderScripts,
        outputs: [
          await outputSummary("采集结果", path.join(marketSpiderDir, "result")),
          await outputSummary("登录缓存", path.join(marketSpiderDir, "cookie")),
          await outputSummary("运行日志", path.join(marketSpiderDir, "logs")),
        ],
        actions: [
          { id: "launch_marketspider_ui", label: "启动控制台", enabled: marketSpiderScripts[0]?.exists ?? false },
          { id: "launch_taobao_spider", label: "启动淘宝", enabled: marketSpiderScripts[1]?.exists ?? false },
          { id: "launch_jd_spider", label: "启动京东", enabled: marketSpiderScripts[2]?.exists ?? false },
          { id: "launch_1688_spider", label: "启动 1688", enabled: marketSpiderScripts[3]?.exists ?? false },
          { id: "launch_cookie_helper", label: "获取 Cookie", enabled: marketSpiderScripts[4]?.exists ?? false },
        ],
      },
      {
        id: "marketspider-pt",
        label: "备用 MarketSpider 脚本",
        source: "pt/MarketSpider-main",
        status: statusFromScripts(marketSpiderPtScripts),
        baseDir: marketSpiderPtDir,
        description: "备用淘宝、京东、1688 爬虫脚本目录。",
        scripts: marketSpiderPtScripts,
        outputs: [await outputSummary("采集结果", path.join(marketSpiderPtDir, "result"))],
        actions: [],
      },
    ],
  };
}

export async function launchCrawlerAction(action: string): Promise<CrawlerLaunchResult> {
  const actionToScript: Record<string, string> = {
    launch_marketspider_ui: "MarketSpider_WebUI.py",
    launch_taobao_spider: "Spider_taobao.py",
    launch_jd_spider: "Spider_jd.py",
    launch_1688_spider: "1688Spider.py",
    launch_cookie_helper: "GetCookie.py",
  };
  const script = actionToScript[action];

  if (!script) {
    throw new Error("Unsupported crawler action.");
  }

  const baseDir = path.join(workspaceRoot(), "MarketSpider-main");
  const scriptPath = path.join(baseDir, script);
  if (!(await exists(scriptPath))) {
    throw new Error(`${script} was not found.`);
  }

  if (action !== "launch_marketspider_ui") {
    terminalCommand(`cd ${JSON.stringify(baseDir)} && python3 ${JSON.stringify(scriptPath)}`);
    return {
      url: null,
      action,
      message: "已在终端启动爬虫脚本。脚本会要求输入关键词、页码或登录信息，采集完成后结果会写入 result 目录。",
    };
  }

  if (await probeMarketSpiderUi(MARKETSPIDER_UI_URL)) {
    return {
      url: MARKETSPIDER_UI_URL,
      action,
      message: "MarketSpider 采集控制台已在运行。",
    };
  }

  return new Promise<CrawlerLaunchResult>((resolve, reject) => {
    const child = spawn("python3", ["-u", scriptPath], {
      cwd: baseDir,
      detached: true,
      env: {
        ...process.env,
        MARKETSPIDER_NO_BROWSER: "1",
        MARKETSPIDER_PORT: "8766",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        url: null,
        action,
        message: "采集控制台进程已启动，但没有拿到浏览器地址。请稍后点“扫描模块”，或检查 MarketSpider 终端日志。",
      });
    }, 8000);

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      const url = text.match(/MarketSpider Web UI:\s*(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1] ?? text.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (!url || settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        url,
        action,
        message: "MarketSpider 采集控制台已启动。请在控制台里配置输出 JSON、登录 Cookie，并启动对应平台采集。",
      });
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}
