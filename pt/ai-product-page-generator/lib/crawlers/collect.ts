import { spawn } from "child_process";
import { access } from "fs/promises";
import path from "path";

import { sanitizeCollectedProductJson } from "@/lib/listing-workflow/ai-product-json";

export type ProductCollectResult = {
  platform: "1688" | "taobao" | "jd";
  sourceUrl: string;
  productId: string;
  fileName: string;
  scrapedData: Record<string, unknown>;
  meta: Record<string, unknown>;
};

function workspaceRoot() {
  return path.resolve(process.cwd(), "../..");
}

function detectPlatform(url: string): ProductCollectResult["platform"] | null {
  const normalized = url.trim().toLowerCase();
  if (normalized.includes("1688.com")) return "1688";
  if (normalized.includes("taobao.com") || normalized.includes("tmall.com")) return "taobao";
  if (normalized.includes("jd.com") || normalized.includes("360buy.com")) return "jd";
  return null;
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function pythonExecutable(root: string) {
  const candidate =
    process.platform === "win32"
      ? path.join(root, "ozon_websit", "backend", ".venv", "Scripts", "python.exe")
      : path.join(root, "ozon_websit", "backend", ".venv", "bin", "python");
  return (await exists(candidate)) ? candidate : "python3";
}

function parseJsonOutput(stdout: string): ProductCollectResult {
  const text = stdout.trim();
  if (!text) {
    throw new Error("采集脚本没有返回 JSON。");
  }

  const parsed = JSON.parse(text) as ProductCollectResult;
  if (!parsed.scrapedData || typeof parsed.scrapedData !== "object") {
    throw new Error("采集脚本返回的数据缺少 scrapedData。");
  }
  return {
    ...parsed,
    scrapedData: sanitizeCollectedProductJson(parsed.scrapedData),
  };
}

export async function collectProductFromUrl(url: string, signal?: AbortSignal): Promise<ProductCollectResult> {
  const platform = detectPlatform(url);
  if (!platform) {
    throw new Error("暂时只识别淘宝、天猫、京东和 1688 商品链接。");
  }

  if (platform !== "1688") {
    throw new Error("主流程已改为直接采集；当前先接通 1688 商品详情。淘宝/京东请先上传已导出的 JSON，后面再接脚本参数化。");
  }

  const root = workspaceRoot();
  const backendDir = path.join(root, "ozon_websit", "backend");
  const scriptPath = path.join(process.cwd(), "scripts", "collect-1688-detail.py");
  const python = await pythonExecutable(root);

  if (signal?.aborted) {
    throw new Error("采集已暂停。");
  }

  return new Promise<ProductCollectResult>((resolve, reject) => {
    const child = spawn(python, [scriptPath, url], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUNBUFFERED: "1",
        NO_PROXY: ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(","),
        no_proxy: ["127.0.0.1", "localhost", process.env.no_proxy].filter(Boolean).join(","),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("采集已暂停。")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("1688 自动浏览器采集超时；如果浏览器弹出了登录或安全验证，请完成后再次点击“启动采集”。")));
    }, 150000);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `采集脚本退出码 ${code}`));
          return;
        }

        try {
          resolve(parseJsonOutput(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
