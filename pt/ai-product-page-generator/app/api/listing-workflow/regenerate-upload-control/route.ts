import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import { z } from "zod";

import { fail, handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  action: z.enum(["pause", "resume", "retry"]),
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function batchPaths() {
  const root = path.resolve(process.cwd(), "storage", "pet-toy-batch");
  return {
    checkpoint: path.join(root, "regenerate-upload-checkpoint.json"),
    control: path.join(root, "regenerate-upload-control.json"),
    source: path.join(root, "production-checkpoint.json"),
    imageMap: path.join(root, "prompt-translated-image-map.json"),
    script: path.resolve(
      process.cwd(),
      "scripts",
      "regenerate-translate-upload-pet-toys.mjs",
    ),
    log: path.resolve(
      process.cwd(),
      "storage",
      "logs",
      "regenerate-upload-queue.log",
    ),
  };
}

async function readRecord(filePath: string) {
  const value = await fsp.readFile(filePath, "utf8").catch(() => "{}");
  return record(JSON.parse(value));
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

function workerIsAlive(checkpoint: Record<string, unknown>) {
  const pid = Number(checkpoint.workerPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkpointIsRecent(checkpoint: Record<string, unknown>, maxAgeMs = 30_000) {
  const timestamp = Date.parse(text(checkpoint.updatedAt));
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
}

function recoverInterruptedJobs(
  checkpoint: Record<string, unknown>,
  action: "resume" | "retry",
) {
  const jobs = record(checkpoint.jobs);
  return {
    ...checkpoint,
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([id, value]) => {
        const job = record(value);
        if (text(job.status) !== "running") return [id, job];
        return [
          id,
          {
            ...job,
            status: action === "retry" ? "failed" : "pending",
            error: "上次后台任务进程中断，已重新加入队列。",
            interruptedAt: new Date().toISOString(),
          },
        ];
      }),
    ),
  };
}

function scopedJobs(checkpoint: Record<string, unknown>) {
  const jobs = Object.values(record(checkpoint.jobs)).map(record);
  return jobs.slice(0, number(checkpoint.targetLimit, jobs.length || 1));
}

function hasRunningJob(checkpoint: Record<string, unknown>) {
  return scopedJobs(checkpoint).some(
    (value) => text(record(value).status) === "running",
  );
}

async function startWorker(params: {
  checkpoint: Record<string, unknown>;
  retryFailedOnly: boolean;
}) {
  const paths = batchPaths();
  const targetLimit = number(params.checkpoint.targetLimit, 100);
  const prompt =
    text(params.checkpoint.prompt) ||
    "以参考商品图为唯一商品依据，为 Ozon 制作高转化俄文商品信息图。";
  const args = [
    paths.script,
    "--limit",
    String(targetLimit),
    "--checkpoint",
    paths.checkpoint,
    "--control",
    paths.control,
    "--source-checkpoint",
    paths.source,
    "--image-map",
    paths.imageMap,
    "--image-provider",
    text(params.checkpoint.imageProvider) || "browser-webai",
    "--image-model",
    text(params.checkpoint.imageModel) || "gpt-image-1.5",
    "--max-images",
    String(number(params.checkpoint.maxImages, 15)),
    "--prompt",
    prompt,
  ];
  if (params.checkpoint.translateImages === false) args.push("--skip-translation");
  if (params.retryFailedOnly) args.push("--retry-failed-only");

  await fsp.mkdir(path.dirname(paths.log), { recursive: true });
  const logFd = fs.openSync(paths.log, "a");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  return child.pid ?? null;
}

export async function POST(request: Request) {
  try {
    const { action } = requestSchema.parse(await request.json());
    const paths = batchPaths();
    let checkpoint = await readRecord(paths.checkpoint);
    const workerAlive = workerIsAlive(checkpoint);
    const active =
      workerAlive || (hasRunningJob(checkpoint) && checkpointIsRecent(checkpoint));
    const now = new Date().toISOString();

    if (action === "pause") {
      if (!active && text(checkpoint.status) !== "starting") {
        return fail("QUEUE_NOT_RUNNING", "当前队列没有运行中的任务", null, 409);
      }
      await writeJsonAtomic(paths.control, {
        pauseRequested: true,
        reason: "用户在等待队列页面请求暂停",
        requestedAt: now,
      });
      await writeJsonAtomic(paths.checkpoint, {
        ...checkpoint,
        status: "pause_requested",
        pauseReason: "正在安全暂停，当前商品完成后停止",
        pauseRequestedAt: now,
        updatedAt: now,
      });
      return ok({ action, status: "pause_requested" });
    }

    if (active || ["running", "starting", "pause_requested"].includes(text(checkpoint.status))) {
      if (active) {
        return fail("QUEUE_ALREADY_RUNNING", "队列已有任务正在运行", null, 409);
      }
      checkpoint = recoverInterruptedJobs(checkpoint, action);
    }

    const failedCount = scopedJobs(checkpoint).filter(
      (value) => text(record(value).status) === "failed",
    ).length;
    if (action === "retry" && failedCount === 0) {
      return fail("NO_FAILED_ITEMS", "当前没有需要重试的失败项", null, 409);
    }

    await writeJsonAtomic(paths.control, {
      pauseRequested: false,
      clearedAt: now,
      action,
    });
    await writeJsonAtomic(paths.checkpoint, {
      ...checkpoint,
      status: "starting",
      pauseReason: null,
      pausedAt: null,
      workerPid: null,
      lastControlAction: action,
      lastControlAt: now,
      updatedAt: now,
    });
    const workerPid = await startWorker({
      checkpoint,
      retryFailedOnly: action === "retry",
    });
    return ok({ action, status: "starting", workerPid, failedCount });
  } catch (error) {
    return handleRouteError(error);
  }
}
