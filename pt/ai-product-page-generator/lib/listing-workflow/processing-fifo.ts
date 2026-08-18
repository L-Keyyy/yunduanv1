import { prisma } from "@/lib/db/prisma";
import type { ProcessingWorkflowContext } from "@/lib/listing-workflow/processing-state";

export type ProcessingLane = "generation" | "translation" | "feature";

type QueueEntry = {
  context: ProcessingWorkflowContext | null;
  queuedAt: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type LaneState = {
  running: boolean;
  pumping: boolean;
  entries: QueueEntry[];
  active: QueueEntry | null;
  releasedTickets: Set<string>;
};

const laneStatusKey: Record<ProcessingLane, string> = {
  generation: "generationStatus",
  translation: "translationStatus",
  feature: "featureStatus",
};

const pendingStatuses = new Set(["queued", "running"]);
const globalQueue = globalThis as typeof globalThis & {
  __listingProcessingFifo?: Map<ProcessingLane, LaneState>;
};
const lanes =
  globalQueue.__listingProcessingFifo ??
  (globalQueue.__listingProcessingFifo = new Map<ProcessingLane, LaneState>());

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function workflowFrom(item: { scrapedData: unknown; workflowData: unknown }) {
  const scrapedData = record(item.scrapedData);
  return {
    ...record(scrapedData.imageWorkflow),
    ...record(record(item.workflowData).imageWorkflow),
  };
}

function queueTime(
  item: { createdAt: Date; scrapedData: unknown; workflowData: unknown },
) {
  const queuedAt = Date.parse(text(workflowFrom(item).queuedAt));
  return Number.isFinite(queuedAt) ? queuedAt : item.createdAt.getTime();
}

function stateFor(lane: ProcessingLane) {
  const current = lanes.get(lane);
  if (current) return current;
  const created: LaneState = {
    running: false,
    pumping: false,
    entries: [],
    active: null,
    releasedTickets: new Set(),
  };
  lanes.set(lane, created);
  return created;
}

async function queueTicket(
  lane: ProcessingLane,
  context: ProcessingWorkflowContext | null,
) {
  if (!context) return Date.now();
  const item = await prisma.listingWorkflowItem.findUnique({
    where: { id: context.itemId },
    select: {
      stage: true,
      createdAt: true,
      scrapedData: true,
      workflowData: true,
    },
  });
  const workflow = item ? workflowFrom(item) : {};
  if (
    !item ||
    item.stage !== "PROCESSING" ||
    text(workflow.runId) !== context.runId ||
    !pendingStatuses.has(text(workflow[laneStatusKey[lane]]))
  ) {
    throw new Error("这次商品加工任务已经结束或被新任务替换。");
  }
  return queueTime(item);
}

function ticketKey(context: ProcessingWorkflowContext | null) {
  return context ? `${context.itemId}:${context.runId}` : "";
}

async function oldestPendingItemId(
  lane: ProcessingLane,
  releasedTickets: Set<string>,
) {
  const items = await prisma.listingWorkflowItem.findMany({
    where: { stage: "PROCESSING" },
    select: {
      id: true,
      createdAt: true,
      scrapedData: true,
      workflowData: true,
    },
  });
  return items
    .filter((item) => {
      const workflow = workflowFrom(item);
      return (
        pendingStatuses.has(text(workflow[laneStatusKey[lane]])) &&
        !releasedTickets.has(`${item.id}:${text(workflow.runId)}`)
      );
    })
    .sort(
      (left, right) =>
        queueTime(left) - queueTime(right) || left.id.localeCompare(right.id),
    )[0]?.id ?? null;
}

async function pump(lane: ProcessingLane) {
  const state = stateFor(lane);
  if (state.running || state.pumping || !state.entries.length) return;
  state.pumping = true;
  try {
    const oldestItemId = await oldestPendingItemId(
      lane,
      state.releasedTickets,
    );
    let entryIndex = oldestItemId
      ? state.entries.findIndex(
          (entry) => entry.context?.itemId === oldestItemId,
        )
      : state.entries.findIndex((entry) => !entry.context);

    if (!oldestItemId && entryIndex < 0) {
      const stale = state.entries.shift();
      stale?.reject(new Error("这次商品加工任务已经结束或被新任务替换。"));
      queueMicrotask(() => void pump(lane));
      return;
    }
    // 更早的商品请求还没到达时留在这里等；它入队后会再次触发 pump。
    if (entryIndex < 0) return;

    const [entry] = state.entries.splice(entryIndex, 1);
    state.running = true;
    state.active = entry;
    const startedAt = Date.now();
    console.info("[processing-fifo] start", {
      lane,
      itemId: entry.context?.itemId ?? null,
      queuedAt: new Date(entry.queuedAt).toISOString(),
      waiting: state.entries.length,
    });
    void entry
      .task()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        console.info("[processing-fifo] finish", {
          lane,
          itemId: entry.context?.itemId ?? null,
          durationMs: Date.now() - startedAt,
        });
        state.running = false;
        state.active = null;
        const releasedTicket = ticketKey(entry.context);
        if (releasedTicket) state.releasedTickets.add(releasedTicket);
        void pump(lane);
      });
  } catch (error) {
    const entry = state.entries.shift();
    entry?.reject(error);
    queueMicrotask(() => void pump(lane));
  } finally {
    state.pumping = false;
  }
}

export async function runProcessingFifo<T>(
  lane: ProcessingLane,
  context: ProcessingWorkflowContext | null,
  task: () => Promise<T>,
): Promise<T> {
  const queuedAt = await queueTicket(lane, context);
  return new Promise<T>((resolve, reject) => {
    const state = stateFor(lane);
    const currentTicket = ticketKey(context);
    if (currentTicket) state.releasedTickets.delete(currentTicket);
    state.entries.push({
      context,
      queuedAt,
      task,
      resolve: (value) => resolve(value as T),
      reject,
    });
    state.entries.sort((left, right) => left.queuedAt - right.queuedAt);
    void pump(lane);
  });
}

export async function readProcessingFifoStatus() {
  const items = await prisma.listingWorkflowItem.findMany({
    where: { stage: "PROCESSING" },
    select: {
      id: true,
      offerId: true,
      title: true,
      createdAt: true,
      scrapedData: true,
      workflowData: true,
    },
  });
  const laneStatus = (lane: ProcessingLane) => {
    const state = stateFor(lane);
    const databaseOrder = items
      .filter((item) =>
        pendingStatuses.has(text(workflowFrom(item)[laneStatusKey[lane]])),
      )
      .sort(
        (left, right) =>
          queueTime(left) - queueTime(right) || left.id.localeCompare(right.id),
      )
      .map((item) => ({
        itemId: item.id,
        offerId: item.offerId,
        title: item.title,
        queuedAt: new Date(queueTime(item)).toISOString(),
        status: text(workflowFrom(item)[laneStatusKey[lane]]),
      }));
    const activeItemId = state.active?.context?.itemId ?? null;
    const waitingItemIds = state.entries.flatMap((entry) =>
      entry.context?.itemId ? [entry.context.itemId] : [],
    );
    const expectedItemId = databaseOrder[0]?.itemId ?? null;
    return {
      activeItemId,
      waitingItemIds,
      databaseOrder,
      fifoCompliant:
        expectedItemId === null ||
        activeItemId === expectedItemId ||
        (!activeItemId && waitingItemIds[0] === expectedItemId),
    };
  };
  return {
    observedAt: new Date().toISOString(),
    lanes: {
      generation: laneStatus("generation"),
      translation: laneStatus("translation"),
      feature: laneStatus("feature"),
    },
  };
}
