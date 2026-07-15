"use client";

import { Activity, ArrowRight, Bot, CheckCircle2, CircleAlert, Laptop, Loader2, Send, Server } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

type RelayTask = {
  id: string;
  message: string;
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  agentMode?: string;
  response?: string;
  error?: string;
  metrics?: { agentProcessingMs?: number; totalMs?: number };
};

type RelayStatus = {
  agent: null | { id: string; mode: string; version: string; connected: boolean; ageMs: number };
  counts: { queued: number; processing: number; completed: number; failed: number };
};

function unwrap<T>(payload: { success?: boolean; data?: T; error?: { message?: string } }): T {
  if (!payload.success) throw new Error(payload.error?.message || "请求失败");
  return payload.data as T;
}

function statusLabel(status: RelayTask["status"]) {
  return { queued: "服务器排队中", processing: "本机正在处理", completed: "三方交换成功", failed: "处理失败" }[status];
}

export default function RelayMvpPage() {
  const [message, setMessage] = useState("请只回复：三方消息交换成功");
  const [task, setTask] = useState<RelayTask | null>(null);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pollingRef = useRef<number | null>(null);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/relay-mvp/tasks", { cache: "no-store" });
      setStatus(unwrap<RelayStatus>(await response.json()));
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(refreshStatus, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!task || task.status === "completed" || task.status === "failed") return;
    pollingRef.current = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/relay-mvp/tasks/${task.id}`, { cache: "no-store" });
        const next = unwrap<RelayTask>(await response.json());
        setTask(next);
        if (next.status === "completed" || next.status === "failed") {
          if (pollingRef.current) window.clearInterval(pollingRef.current);
          pollingRef.current = null;
          void refreshStatus();
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 700);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    };
  }, [task?.id, task?.status]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError("");
    setTask(null);
    try {
      const response = await fetch("/api/relay-mvp/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const next = unwrap<RelayTask>(await response.json());
      setTask(next);
      void refreshStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const nodes = [
    { label: "客户页面", detail: "发送问题 / 接收结果", icon: Laptop, active: Boolean(task) },
    { label: "中继服务器", detail: task ? statusLabel(task.status) : "等待测试任务", icon: Server, active: Boolean(task) },
    { label: "我的电脑", detail: status?.agent?.connected ? `${status.agent.id} · ${status.agent.mode}` : "Agent 离线", icon: Bot, active: task?.status === "processing" || task?.status === "completed" },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-blue-600 dark:text-blue-400">方案二 · 最小可行验证</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">三方消息中继测试</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">客户机 → 服务器 → 我的电脑 → 服务器 → 客户机</p>
        </div>
        <div className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${status?.agent?.connected ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${status?.agent?.connected ? "bg-emerald-500" : "bg-amber-500"}`} />
          {status?.agent?.connected ? "本机 Agent 在线" : "本机 Agent 离线"}
        </div>
      </header>

      <section className="grid gap-3 rounded-3xl border border-slate-200 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.03] md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center md:p-6">
        {nodes.map((node, index) => {
          const Icon = node.icon;
          return (
            <div className="contents" key={node.label}>
              <div className={`rounded-2xl border p-5 transition ${node.active ? "border-blue-300 bg-blue-50/70 dark:border-blue-400/30 dark:bg-blue-500/10" : "border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/[0.03]"}`}>
                <Icon className={`h-6 w-6 ${node.active ? "text-blue-600 dark:text-blue-400" : "text-slate-400"}`} />
                <p className="mt-4 font-semibold">{node.label}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{node.detail}</p>
              </div>
              {index < nodes.length - 1 ? <ArrowRight className="mx-auto hidden h-5 w-5 text-slate-300 md:block" /> : null}
            </div>
          );
        })}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.03] md:p-6">
        <form onSubmit={submit} className="space-y-4">
          <label htmlFor="relay-message" className="block text-sm font-semibold">测试消息</label>
          <textarea id="relay-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={4} maxLength={4000} className="w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 dark:border-white/10 dark:bg-black/20 dark:focus:ring-blue-500/10" />
          <button type="submit" disabled={submitting || !message.trim()} className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            发送三方测试
          </button>
        </form>
      </section>

      {task ? (
        <section className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.03] md:p-6">
          <div className="flex items-center gap-3">
            {task.status === "completed" ? <CheckCircle2 className="h-6 w-6 text-emerald-500" /> : task.status === "failed" ? <CircleAlert className="h-6 w-6 text-red-500" /> : <Loader2 className="h-6 w-6 animate-spin text-blue-500" />}
            <div>
              <p className="font-semibold">{statusLabel(task.status)}</p>
              <p className="font-mono text-xs text-slate-400">task_id: {task.id}</p>
            </div>
          </div>
          {task.response ? <div className="mt-5 whitespace-pre-wrap rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-950 dark:bg-emerald-500/10 dark:text-emerald-100">{task.response}</div> : null}
          {task.error ? <div className="mt-5 whitespace-pre-wrap rounded-2xl bg-red-50 p-4 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{task.error}</div> : null}
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500 dark:text-slate-400">
            <span>执行器：{task.agentId || "等待领取"}</span>
            <span>模式：{task.agentMode || "-"}</span>
            <span>本机处理：{task.metrics?.agentProcessingMs ?? "-"} ms</span>
            <span>端到端：{task.metrics?.totalMs ?? "-"} ms</span>
          </div>
        </section>
      ) : null}

      {error ? <div className="flex items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"><CircleAlert className="h-4 w-4" />{error}</div> : null}

      <section className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-xs text-slate-500 dark:border-white/15 dark:text-slate-400">
        <Activity className="h-4 w-4" />
        当前队列：{status?.counts.queued ?? 0}，处理中：{status?.counts.processing ?? 0}。MVP任务保留1小时。
      </section>
    </div>
  );
}
