import crypto from "crypto";

export type RelayTaskStatus = "queued" | "processing" | "completed" | "failed";

export type RelayTask = {
  id: string;
  message: string;
  status: RelayTaskStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  agentId?: string;
  agentMode?: string;
  response?: string;
  error?: string;
  metrics?: {
    agentProcessingMs?: number;
    totalMs?: number;
  };
};

type AgentStatus = {
  id: string;
  mode: string;
  version: string;
  lastSeenAt: string;
};

type RelayState = {
  tasks: Map<string, RelayTask>;
  agent: AgentStatus | null;
};

const STATE_KEY = "__bananaMallRelayMvpState";
const TASK_TTL_MS = 60 * 60 * 1000;
const LEASE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_TASKS = 100;

function state(): RelayState {
  const target = globalThis as typeof globalThis & { __bananaMallRelayMvpState?: RelayState };
  if (!target[STATE_KEY]) {
    target[STATE_KEY] = { tasks: new Map(), agent: null };
  }
  return target[STATE_KEY];
}

function nowIso() {
  return new Date().toISOString();
}

function maintain() {
  const current = Date.now();
  const relay = state();

  for (const [id, task] of relay.tasks) {
    const updatedAt = Date.parse(task.updatedAt);
    if (current - updatedAt > TASK_TTL_MS) {
      relay.tasks.delete(id);
      continue;
    }
    if (
      task.status === "processing" &&
      task.claimedAt &&
      current - Date.parse(task.claimedAt) > LEASE_TIMEOUT_MS
    ) {
      task.status = "queued";
      task.updatedAt = nowIso();
      delete task.claimedAt;
      delete task.agentId;
      delete task.agentMode;
    }
  }

  if (relay.tasks.size > MAX_TASKS) {
    const oldest = [...relay.tasks.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, relay.tasks.size - MAX_TASKS);
    for (const task of oldest) relay.tasks.delete(task.id);
  }
}

export function createRelayTask(message: string): RelayTask {
  maintain();
  const timestamp = nowIso();
  const task: RelayTask = {
    id: crypto.randomUUID(),
    message,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state().tasks.set(task.id, task);
  return { ...task };
}

export function getRelayTask(id: string): RelayTask | null {
  maintain();
  const task = state().tasks.get(id);
  return task ? { ...task, metrics: task.metrics ? { ...task.metrics } : undefined } : null;
}

export function claimRelayTask(agent: Omit<AgentStatus, "lastSeenAt">): RelayTask | null {
  maintain();
  const relay = state();
  relay.agent = { ...agent, lastSeenAt: nowIso() };
  const task = [...relay.tasks.values()]
    .filter((candidate) => candidate.status === "queued")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  if (!task) return null;

  task.status = "processing";
  task.agentId = agent.id;
  task.agentMode = agent.mode;
  task.claimedAt = nowIso();
  task.updatedAt = task.claimedAt;
  return { ...task };
}

export function completeRelayTask(input: {
  taskId: string;
  agentId: string;
  status: "completed" | "failed";
  response?: string;
  error?: string;
  processingMs?: number;
}) {
  maintain();
  const task = state().tasks.get(input.taskId);
  if (!task) return null;
  if (task.status !== "processing" || task.agentId !== input.agentId) return undefined;

  const completedAt = nowIso();
  task.status = input.status;
  task.updatedAt = completedAt;
  task.completedAt = completedAt;
  task.response = input.response;
  task.error = input.error;
  task.metrics = {
    agentProcessingMs: input.processingMs,
    totalMs: Date.now() - Date.parse(task.createdAt),
  };
  return { ...task, metrics: { ...task.metrics } };
}

export function relayStatus() {
  maintain();
  const relay = state();
  const counts = { queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const task of relay.tasks.values()) counts[task.status] += 1;
  const agentAgeMs = relay.agent
    ? Math.max(0, Date.now() - Date.parse(relay.agent.lastSeenAt))
    : null;
  return {
    agent: relay.agent
      ? { ...relay.agent, connected: agentAgeMs !== null && agentAgeMs < 15_000, ageMs: agentAgeMs }
      : null,
    counts,
  };
}

export function isRelayAgentAuthorized(request: Request) {
  const configured = process.env.RELAY_MVP_AGENT_TOKEN?.trim();
  if (!configured) return false;
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || supplied.length !== configured.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}
