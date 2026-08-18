import fs from "fs/promises";
import path from "path";

import { handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
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

function isRecent(value: unknown, maxAgeMs = 30_000) {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
}

export async function GET() {
  try {
    const checkpointPath = path.resolve(
      process.cwd(),
      "storage/pet-toy-batch/regenerate-upload-checkpoint.json",
    );
    const sourcePath = path.resolve(
      process.cwd(),
      "storage/pet-toy-batch/production-checkpoint.json",
    );
    const controlPath = path.resolve(
      process.cwd(),
      "storage/pet-toy-batch/regenerate-upload-control.json",
    );
    const [checkpointText, sourceText, controlText] = await Promise.all([
      fs.readFile(checkpointPath, "utf8").catch(() => "{}"),
      fs.readFile(sourcePath, "utf8").catch(() => "{}"),
      fs.readFile(controlPath, "utf8").catch(() => "{}"),
    ]);
    const checkpoint = record(JSON.parse(checkpointText));
    const source = record(JSON.parse(sourceText));
    const control = record(JSON.parse(controlText));
    const rawBatchStatus = text(checkpoint.status) || "idle";
    const workerAlive = workerIsAlive(checkpoint);
    const workerStoppedUnexpectedly =
      ["running", "starting", "pause_requested"].includes(rawBatchStatus) &&
      !workerAlive &&
      !isRecent(checkpoint.updatedAt);
    const importedSourceJobs = (Array.isArray(source.jobs)
      ? source.jobs.map(record)
      : []
    ).filter(
      (job) =>
        text(job.status) === "imported" &&
        Boolean(record(job.input).workflowItemId),
    );
    const requestedLimit = Number(checkpoint.targetLimit);
    const targetLimit =
      Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, importedSourceJobs.length)
        : importedSourceJobs.length;
    const targetSourceJobs = importedSourceJobs.slice(0, targetLimit);
    const targetItemIds = new Set(
      targetSourceJobs.map((job) => text(record(job.input).workflowItemId)),
    );
    const jobs = Object.values(record(checkpoint.jobs))
      .map(record)
      .filter((job) => targetItemIds.has(text(job.itemId)));
    const visibleJobs = jobs.map((job) =>
      workerStoppedUnexpectedly && text(job.status) === "running"
        ? {
            ...job,
            status: "pending",
            error:
              text(job.error) ||
              "后台任务进程已停止，点击继续队列后会从当前商品重新处理。",
          }
        : job,
    );
    const total = targetSourceJobs.length;
    const counts = visibleJobs.reduce<{
      completed: number;
      failed: number;
      running: number;
    }>(
      (result, job) => {
        const status = text(job.status);
        if (status === "complete") result.completed += 1;
        else if (status === "failed") result.failed += 1;
        else if (status === "running") result.running += 1;
        return result;
      },
      { completed: 0, failed: 0, running: 0 },
    );
    const current = [...visibleJobs].reverse().find(
      (job) => text(job.status) === "running",
    );
    const latestFailure = [...visibleJobs].reverse().find(
      (job) => text(job.status) === "failed",
    );
    const queueItems = visibleJobs
      .filter((job) => text(job.status) !== "complete")
      .map((job) => ({
        itemId: text(job.itemId),
        offerId: text(job.offerId),
        status: text(job.status),
        error: text(job.error),
        startedAt: text(job.startedAt),
        failedAt: text(job.failedAt),
      }));
    const pauseRequested = control.pauseRequested === true;
    const batchStatus = workerStoppedUnexpectedly ? "paused" : rawBatchStatus;
    const paused =
      batchStatus === "paused" || pauseRequested || workerStoppedUnexpectedly;
    return ok({
      total,
      ...counts,
      batchStatus,
      paused,
      pauseRequested: pauseRequested && batchStatus !== "paused",
      pauseReason:
        (workerStoppedUnexpectedly
          ? "后台任务进程已停止，点击继续队列即可恢复。"
          : "") ||
        text(checkpoint.pauseReason) ||
        text(control.reason),
      pausedAt:
        text(checkpoint.pausedAt) ||
        (workerStoppedUnexpectedly ? text(checkpoint.updatedAt) : ""),
      pending: Math.max(total - counts.completed - counts.failed - counts.running, 0),
      percent: total ? Math.round((counts.completed / total) * 1000) / 10 : 0,
      currentOfferId: text(current?.offerId),
      latestFailureOfferId: text(latestFailure?.offerId),
      latestFailure: text(latestFailure?.error),
      translationPaused: checkpoint.translateImages === false,
      workerPid: workerAlive ? Number(checkpoint.workerPid) || null : null,
      workerAlive,
      workerStoppedUnexpectedly,
      retryingFailedOnly: checkpoint.retryFailedOnly === true,
      updatedAt: text(checkpoint.updatedAt),
      startedAt: text(checkpoint.startedAt),
      queueItems,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
