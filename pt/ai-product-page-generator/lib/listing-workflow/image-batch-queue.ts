import {
  ImageBatchStatus,
  ImageQueueTaskStatus,
  ImageQueueTaskType,
  Prisma,
} from "@prisma/client";
import { nanoid } from "nanoid";

import { BROWSER_AI_PROVIDER_ID } from "@/lib/browser-ai/client";
import { prisma } from "@/lib/db/prisma";
import { generateListingWorkflowImage } from "@/lib/listing-workflow/image-generation";

const GLOBAL_WORKER_LIMIT = 4;
const STALE_LOCK_MS = 10 * 60_000;
const HEARTBEAT_MS = 30_000;

export type CreateImageBatchInput = {
  name: string;
  providerId?: string;
  model: string;
  prompt: string;
  aspectRatio: "1:1" | "3:4" | "9:16";
  requestOrigin: string;
  maxConcurrency: number;
  maxAttempts: number;
  products: Array<{
    listingWorkflowItemId?: string;
    offerId?: string;
    title: string;
    sourceUrl?: string;
    sourceImageUrl?: string;
    images: Array<{
      type: ImageQueueTaskType;
      prompt?: string;
      referenceImages?: string[];
      priority?: number;
    }>;
  }>;
};

type QueueRuntime = {
  promise: Promise<void> | null;
  wakeTimer: ReturnType<typeof setTimeout> | null;
};

const globalForQueue = globalThis as typeof globalThis & {
  bananaMallImageQueue?: QueueRuntime;
};

const runtimeState =
  globalForQueue.bananaMallImageQueue ??
  (globalForQueue.bananaMallImageQueue = { promise: null, wakeTimer: null });

function cleanOptional(value?: string) {
  const clean = value?.trim();
  return clean || undefined;
}

function renderPrompt(template: string, product: { title: string; offerId?: string }, imageIndex: number) {
  return template
    .replaceAll("{{title}}", product.title)
    .replaceAll("{{offerId}}", product.offerId ?? "")
    .replaceAll("{{index}}", String(imageIndex + 1));
}

export async function createImageBatch(input: CreateImageBatchInput) {
  const totalTasks = input.products.reduce((sum, product) => sum + product.images.length, 0);
  const batch = await prisma.imageBatch.create({
    data: {
      name: input.name.trim(),
      providerId: cleanOptional(input.providerId),
      model: input.model,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      requestOrigin: input.requestOrigin,
      maxConcurrency: input.maxConcurrency,
      maxAttempts: input.maxAttempts,
      totalProducts: input.products.length,
      totalTasks,
      products: {
        create: input.products.map((product) => ({
          listingWorkflowItemId: cleanOptional(product.listingWorkflowItemId),
          offerId: cleanOptional(product.offerId),
          title: product.title.trim(),
          sourceUrl: cleanOptional(product.sourceUrl),
          sourceImageUrl: cleanOptional(product.sourceImageUrl),
          totalTasks: product.images.length,
          inputPayload: {
            sourceUrl: cleanOptional(product.sourceUrl) ?? null,
            sourceImageUrl: cleanOptional(product.sourceImageUrl) ?? null,
          },
          imageTasks: {
            create: product.images.map((image, imageIndex) => {
              const references = (image.referenceImages ?? []).filter(Boolean).slice(0, 4);
              if (references.length === 0 && product.sourceImageUrl) {
                references.push(product.sourceImageUrl);
              }
              return {
                type: image.type,
                providerId: cleanOptional(input.providerId),
                model: input.model,
                prompt: renderPrompt(image.prompt?.trim() || input.prompt, product, imageIndex),
                aspectRatio: input.aspectRatio,
                sourceImageUrl: cleanOptional(product.sourceImageUrl),
                referenceImages: references,
                maxAttempts: input.maxAttempts,
                priority: image.priority ?? 0,
              };
            }),
          },
        })),
      },
    },
    include: {
      products: {
        include: { imageTasks: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  kickImageBatchWorker();
  return batch;
}

export async function listImageBatches(take = 30) {
  recoverAndKick();
  return prisma.imageBatch.findMany({
    take: Math.min(Math.max(take, 1), 100),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { products: true } } },
  });
}

export async function getImageBatch(batchId: string) {
  recoverAndKick();
  return prisma.imageBatch.findUnique({
    where: { id: batchId },
    include: {
      products: {
        orderBy: { createdAt: "asc" },
        include: { imageTasks: { orderBy: { createdAt: "asc" } } },
      },
    },
  });
}

export async function controlImageBatch(
  batchId: string,
  action: "pause" | "resume" | "retry_failed" | "cancel",
) {
  const existing = await prisma.imageBatch.findUnique({ where: { id: batchId } });
  if (!existing) throw new Error("Image batch not found");

  if (action === "pause") {
    await prisma.imageBatch.update({
      where: { id: batchId },
      data: { status: ImageBatchStatus.PAUSED },
    });
  } else if (action === "cancel") {
    await prisma.$transaction([
      prisma.imageQueueTask.updateMany({
        where: {
          productTask: { batchId },
          status: { in: [ImageQueueTaskStatus.PENDING, ImageQueueTaskStatus.RETRYING] },
        },
        data: {
          status: ImageQueueTaskStatus.CANCELLED,
          completedAt: new Date(),
          errorMessage: null,
        },
      }),
      prisma.imageBatchProduct.updateMany({
        where: { batchId, status: { in: [ImageBatchStatus.PENDING, ImageBatchStatus.PAUSED] } },
        data: { status: ImageBatchStatus.CANCELLED, completedAt: new Date() },
      }),
      prisma.imageBatch.update({
        where: { id: batchId },
        data: { status: ImageBatchStatus.CANCELLED, completedAt: new Date() },
      }),
    ]);
  } else if (action === "retry_failed") {
    await prisma.$transaction([
      prisma.imageQueueTask.updateMany({
        where: { productTask: { batchId }, status: ImageQueueTaskStatus.FAILED },
        data: {
          status: ImageQueueTaskStatus.PENDING,
          attempt: 0,
          availableAt: new Date(),
          lockedAt: null,
          heartbeatAt: null,
          workerId: null,
          errorMessage: null,
          completedAt: null,
        },
      }),
      prisma.imageBatchProduct.updateMany({
        where: { batchId, status: { in: [ImageBatchStatus.FAILED, ImageBatchStatus.PARTIAL] } },
        data: { status: ImageBatchStatus.PENDING, completedAt: null },
      }),
      prisma.imageBatch.update({
        where: { id: batchId },
        data: { status: ImageBatchStatus.PENDING, completedAt: null },
      }),
    ]);
    kickImageBatchWorker();
  } else {
    if (existing.status !== ImageBatchStatus.CANCELLED) {
      await prisma.imageBatch.update({
        where: { id: batchId },
        data: {
          status: ImageBatchStatus.PENDING,
          completedAt: null,
        },
      });
      await refreshBatch(batchId);
      kickImageBatchWorker();
    }
  }

  return getImageBatch(batchId);
}

function recoverAndKick() {
  void recoverStaleTasks().finally(() => kickImageBatchWorker());
}

async function recoverStaleTasks() {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  await prisma.imageQueueTask.updateMany({
    where: {
      status: ImageQueueTaskStatus.RUNNING,
      OR: [{ heartbeatAt: { lt: staleBefore } }, { heartbeatAt: null, lockedAt: { lt: staleBefore } }],
    },
    data: {
      status: ImageQueueTaskStatus.RETRYING,
      availableAt: new Date(),
      lockedAt: null,
      heartbeatAt: null,
      workerId: null,
      errorMessage: "任务进程中断，已自动重新排队。",
    },
  });
}

type ClaimedTask = Prisma.ImageQueueTaskGetPayload<{
  include: { productTask: { include: { batch: true } } };
}>;

async function claimReadyTasks(limit: number): Promise<ClaimedTask[]> {
  const now = new Date();
  const [candidates, runningTasks] = await Promise.all([
    prisma.imageQueueTask.findMany({
      where: {
        status: { in: [ImageQueueTaskStatus.PENDING, ImageQueueTaskStatus.RETRYING] },
        availableAt: { lte: now },
        productTask: {
          batch: { status: { in: [ImageBatchStatus.PENDING, ImageBatchStatus.RUNNING] } },
        },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 50,
      include: { productTask: { include: { batch: true } } },
    }),
    prisma.imageQueueTask.findMany({
      where: { status: ImageQueueTaskStatus.RUNNING },
      select: { providerId: true, productTask: { select: { batchId: true } } },
    }),
  ]);

  const runningByBatch = new Map<string, number>();
  let browserRunning = 0;
  for (const task of runningTasks) {
    const batchId = task.productTask.batchId;
    runningByBatch.set(batchId, (runningByBatch.get(batchId) ?? 0) + 1);
    if (task.providerId === BROWSER_AI_PROVIDER_ID) browserRunning += 1;
  }

  const claimed: ClaimedTask[] = [];
  for (const task of candidates) {
    if (claimed.length >= limit) break;
    const batchId = task.productTask.batchId;
    const batchRunning = runningByBatch.get(batchId) ?? 0;
    if (batchRunning >= task.productTask.batch.maxConcurrency) continue;
    if (task.providerId === BROWSER_AI_PROVIDER_ID && browserRunning >= 1) continue;

    const workerId = `image-worker-${process.pid}-${nanoid(6)}`;
    const updated = await prisma.imageQueueTask.updateMany({
      where: {
        id: task.id,
        status: { in: [ImageQueueTaskStatus.PENDING, ImageQueueTaskStatus.RETRYING] },
      },
      data: {
        status: ImageQueueTaskStatus.RUNNING,
        attempt: { increment: 1 },
        workerId,
        lockedAt: now,
        heartbeatAt: now,
        startedAt: task.startedAt ?? now,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) continue;

    await prisma.$transaction([
      prisma.imageBatch.update({
        where: { id: batchId },
        data: { status: ImageBatchStatus.RUNNING, startedAt: task.productTask.batch.startedAt ?? now },
      }),
      prisma.imageBatchProduct.update({
        where: { id: task.productTaskId },
        data: { status: ImageBatchStatus.RUNNING, startedAt: task.productTask.startedAt ?? now },
      }),
    ]);

    runningByBatch.set(batchId, batchRunning + 1);
    if (task.providerId === BROWSER_AI_PROVIDER_ID) browserRunning += 1;
    claimed.push({ ...task, status: ImageQueueTaskStatus.RUNNING, attempt: task.attempt + 1, workerId });
  }
  return claimed;
}

function parseReferenceImages(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 4);
}

async function processTask(task: ClaimedTask) {
  const heartbeat = setInterval(() => {
    void prisma.imageQueueTask.updateMany({
      where: { id: task.id, status: ImageQueueTaskStatus.RUNNING, workerId: task.workerId },
      data: { heartbeatAt: new Date() },
    });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const result = await generateListingWorkflowImage(
      {
        providerId: task.providerId ?? undefined,
        model: task.model,
        prompt: task.prompt,
        aspectRatio: task.aspectRatio as "1:1" | "3:4" | "9:16",
        referenceImages: parseReferenceImages(task.referenceImages),
        useReferenceImages: true,
      },
      task.productTask.batch.requestOrigin,
    );
    await prisma.imageQueueTask.update({
      where: { id: task.id },
      data: {
        status: ImageQueueTaskStatus.SUCCESS,
        resultImageUrl: result.imageUrl,
        resultFilePath: result.filePath,
        resultPayload: result as unknown as Prisma.InputJsonValue,
        errorMessage: null,
        lockedAt: null,
        heartbeatAt: null,
        workerId: null,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    const errorMessage = (error instanceof Error ? error.message : "图片任务执行失败").slice(0, 2000);
    const retrying = task.attempt < task.maxAttempts;
    const delayMs = Math.min(30_000, 2_000 * 2 ** Math.max(task.attempt - 1, 0));
    await prisma.imageQueueTask.update({
      where: { id: task.id },
      data: {
        status: retrying ? ImageQueueTaskStatus.RETRYING : ImageQueueTaskStatus.FAILED,
        availableAt: retrying ? new Date(Date.now() + delayMs) : new Date(),
        errorMessage,
        lockedAt: null,
        heartbeatAt: null,
        workerId: null,
        completedAt: retrying ? null : new Date(),
      },
    });
    if (retrying) scheduleWorker(delayMs + 100);
  } finally {
    clearInterval(heartbeat);
    await refreshProductAndBatch(task.productTaskId);
  }
}

async function refreshProductAndBatch(productTaskId: string) {
  const product = await prisma.imageBatchProduct.findUnique({
    where: { id: productTaskId },
    include: { imageTasks: true, batch: true },
  });
  if (!product) return;

  const succeeded = product.imageTasks.filter((task) => task.status === ImageQueueTaskStatus.SUCCESS);
  const failed = product.imageTasks.filter((task) => task.status === ImageQueueTaskStatus.FAILED);
  const cancelled = product.imageTasks.filter((task) => task.status === ImageQueueTaskStatus.CANCELLED);
  const running = product.imageTasks.filter((task) => task.status === ImageQueueTaskStatus.RUNNING);
  const active = product.imageTasks.filter(
    (task) =>
      task.status === ImageQueueTaskStatus.PENDING ||
      task.status === ImageQueueTaskStatus.RETRYING ||
      task.status === ImageQueueTaskStatus.RUNNING,
  );

  let productStatus = product.status;
  if (active.length > 0) {
    productStatus = running.length > 0 ? ImageBatchStatus.RUNNING : ImageBatchStatus.PENDING;
  } else if (succeeded.length === product.imageTasks.length) {
    productStatus = ImageBatchStatus.SUCCESS;
  } else if (cancelled.length === product.imageTasks.length) {
    productStatus = ImageBatchStatus.CANCELLED;
  } else if (succeeded.length > 0) {
    productStatus = ImageBatchStatus.PARTIAL;
  } else {
    productStatus = ImageBatchStatus.FAILED;
  }

  await prisma.imageBatchProduct.update({
    where: { id: product.id },
    data: {
      status: productStatus,
      succeededTasks: succeeded.length,
      failedTasks: failed.length,
      outputPayload: {
        images: succeeded.map((task) => ({
          taskId: task.id,
          type: task.type,
          imageUrl: task.resultImageUrl,
          filePath: task.resultFilePath,
        })),
      },
      completedAt: active.length === 0 ? new Date() : null,
    },
  });

  await refreshBatch(product.batchId);
}

async function refreshBatch(batchId: string) {
  const batch = await prisma.imageBatch.findUnique({
    where: { id: batchId },
    include: { products: { include: { imageTasks: true } } },
  });
  if (!batch) return;

  const tasks = batch.products.flatMap((product) => product.imageTasks);
  const succeeded = tasks.filter((task) => task.status === ImageQueueTaskStatus.SUCCESS).length;
  const failed = tasks.filter((task) => task.status === ImageQueueTaskStatus.FAILED).length;
  const cancelled = tasks.filter((task) => task.status === ImageQueueTaskStatus.CANCELLED).length;
  const running = tasks.filter((task) => task.status === ImageQueueTaskStatus.RUNNING).length;
  const active = tasks.filter(
    (task) =>
      task.status === ImageQueueTaskStatus.PENDING ||
      task.status === ImageQueueTaskStatus.RETRYING ||
      task.status === ImageQueueTaskStatus.RUNNING,
  ).length;

  let status = batch.status;
  if (batch.status !== ImageBatchStatus.PAUSED && batch.status !== ImageBatchStatus.CANCELLED) {
    if (active > 0) status = running > 0 ? ImageBatchStatus.RUNNING : ImageBatchStatus.PENDING;
    else if (succeeded === tasks.length) status = ImageBatchStatus.SUCCESS;
    else if (cancelled === tasks.length) status = ImageBatchStatus.CANCELLED;
    else if (succeeded > 0) status = ImageBatchStatus.PARTIAL;
    else status = ImageBatchStatus.FAILED;
  }

  await prisma.imageBatch.update({
    where: { id: batchId },
    data: {
      status,
      succeededTasks: succeeded,
      failedTasks: failed,
      completedAt: active === 0 ? batch.completedAt ?? new Date() : null,
    },
  });
}

async function runWorker() {
  await recoverStaleTasks();
  while (true) {
    const claimed = await claimReadyTasks(GLOBAL_WORKER_LIMIT);
    if (claimed.length === 0) return;
    await Promise.all(claimed.map(processTask));
  }
}

export function kickImageBatchWorker() {
  if (runtimeState.promise) return runtimeState.promise;
  runtimeState.promise = runWorker()
    .catch((error) => {
      console.error("[image-batch-worker]", error);
    })
    .finally(() => {
      runtimeState.promise = null;
    });
  return runtimeState.promise;
}

function scheduleWorker(delayMs: number) {
  if (runtimeState.wakeTimer) return;
  runtimeState.wakeTimer = setTimeout(() => {
    runtimeState.wakeTimer = null;
    kickImageBatchWorker();
  }, delayMs);
  runtimeState.wakeTimer.unref?.();
}
