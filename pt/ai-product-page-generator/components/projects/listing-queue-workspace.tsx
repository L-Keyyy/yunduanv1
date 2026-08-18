"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  Images,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type QueueItem = {
  itemId: string;
  offerId: string;
  status: string;
  error: string;
  startedAt: string;
  failedAt: string;
};

type QueueProgress = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  percent: number;
  batchStatus: string;
  paused: boolean;
  pauseRequested: boolean;
  pauseReason: string;
  pausedAt: string;
  currentOfferId: string;
  latestFailureOfferId: string;
  latestFailure: string;
  translationPaused: boolean;
  updatedAt: string;
  queueItems: QueueItem[];
};

type QueueControlAction = "pause" | "resume" | "retry";

type CopiedProduct = {
  key: string;
  storeId: string;
  storeName: string;
  offerId: string;
  productId: string;
  name: string;
  imageUrl: string;
  imageCount: number;
};

type CopiedImageProgress = {
  status: string;
  total: number;
  uploaded: number;
  failed: number;
  pending: number;
  percent: number;
  workerAlive: boolean;
  callsFeatureAi: boolean;
  callsProductImport: boolean;
  pauseReason: string;
};

function timeLabel(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

function CopiedProductImageQueue() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [prefix, setPrefix] = useState("RR4X-");
  const [products, setProducts] = useState<CopiedProduct[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [action, setAction] = useState<"start" | "pause" | "resume" | "retry" | null>(null);
  const [progress, setProgress] = useState<CopiedImageProgress | null>(null);

  const refreshProgress = useCallback(async () => {
    const response = await fetch(
      "/api/listing-workflow/copied-product-images/progress",
      { cache: "no-store" },
    );
    const payload = await response.json();
    if (response.ok && payload?.success) setProgress(payload.data);
  }, []);

  useEffect(() => {
    void refreshProgress();
    const timer = window.setInterval(() => void refreshProgress(), 4_000);
    return () => window.clearInterval(timer);
  }, [refreshProgress]);

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const response = await fetch(
        `/api/listing-workflow/copied-product-images?prefix=${encodeURIComponent(prefix)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message || "Ozon 商品读取失败");
      }
      setProducts(payload.data.products);
      setSelected(new Set());
      setPickerOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ozon 商品读取失败");
    } finally {
      setLoadingProducts(false);
    }
  }, [prefix]);

  const control = useCallback(async (
    nextAction: "start" | "pause" | "resume" | "retry",
  ) => {
    setAction(nextAction);
    try {
      const body = nextAction === "start"
        ? {
            action: nextAction,
            products: products
              .filter((product) => selected.has(product.key))
              .map((product) => ({ storeId: product.storeId, offerId: product.offerId })),
          }
        : { action: nextAction };
      const response = await fetch("/api/listing-workflow/copied-product-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message || "图片重生队列操作失败");
      }
      if (nextAction === "start") setPickerOpen(false);
      toast.success(
        nextAction === "start"
          ? `已将 ${selected.size} 个商品加入图片重生队列`
          : nextAction === "pause"
            ? "已请求暂停，当前商品完成后停止"
            : nextAction === "resume"
              ? "图片重生队列已继续"
              : "失败项已重新进入队列",
      );
      await refreshProgress();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片重生队列操作失败");
    } finally {
      setAction(null);
    }
  }, [products, refreshProgress, selected]);

  const active = Boolean(progress?.workerAlive) || ["running", "starting"].includes(progress?.status || "");
  const paused = (progress?.status || "").startsWith("paused");

  return (
    <section className="rounded-3xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-6 dark:border-violet-400/20 dark:from-violet-500/10 dark:to-black/10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Images className="h-5 w-5 text-violet-600" />
            <h2 className="text-xl font-semibold">跟卖商品图片重生</h2>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
            勾选已存在的 Ozon 商品后，仅将现有主图送入豆包四宫格生图链路；裁剪图替换原主图并追加到原商品，不运行特征 AI，也不新建商品。
          </p>
          {progress?.total ? (
            <p className="mt-2 text-sm font-medium text-violet-700 dark:text-violet-300">
              {progress.uploaded}/{progress.total} 已替换 · {progress.pending} 待处理 · {progress.failed} 失败 · {progress.percent}%
              {paused && progress.pauseReason ? ` · ${progress.pauseReason}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 items-center rounded-xl border border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-black/20">
            <Search className="mr-2 h-4 w-4 text-slate-400" />
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              className="w-28 bg-transparent text-sm outline-none"
              placeholder="商品前缀"
            />
          </div>
          <Button onClick={() => void loadProducts()} disabled={loadingProducts || active}>
            {loadingProducts ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
            选择商品重新生图
          </Button>
          {active || paused ? (
            <Button
              variant="outline"
              onClick={() => void control(paused ? "resume" : "pause")}
              disabled={Boolean(action)}
            >
              {paused ? <PlayCircle className="mr-2 h-4 w-4" /> : <PauseCircle className="mr-2 h-4 w-4" />}
              {paused ? "继续" : "暂停"}
            </Button>
          ) : null}
          {progress?.failed ? (
            <Button variant="outline" onClick={() => void control("retry")} disabled={Boolean(action)}>
              <RotateCcw className="mr-2 h-4 w-4" />重试失败项
            </Button>
          ) : null}
        </div>
      </div>

      {progress?.total ? (
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-950/60">
          <div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${Math.min(progress.percent, 100)}%` }} />
        </div>
      ) : null}

      {pickerOpen ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-[#111113]">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-white/10">
              <div>
                <h3 className="text-lg font-semibold">选择需要重新生成图片的商品</h3>
                <p className="mt-1 text-xs text-slate-500">已选 {selected.size}/{products.length}，支持多选</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}><X className="h-5 w-5" /></Button>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-3 dark:border-white/10">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelected(
                  selected.size === products.length
                    ? new Set()
                    : new Set(products.map((product) => product.key)),
                )}
              >
                {selected.size === products.length ? "取消全选" : "全选"}
              </Button>
              <Button onClick={() => void control("start")} disabled={!selected.size || Boolean(action)}>
                {action === "start" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
                开始重新生成并替换主图
              </Button>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {products.map((product) => {
                const checked = selected.has(product.key);
                return (
                  <button
                    type="button"
                    key={product.key}
                    onClick={() => setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(product.key)) next.delete(product.key);
                      else next.add(product.key);
                      return next;
                    })}
                    className={`overflow-hidden rounded-2xl border-2 text-left transition ${checked ? "border-black ring-2 ring-black/15 dark:border-white" : "border-slate-200 hover:border-slate-400 dark:border-white/10"}`}
                  >
                    <div className="aspect-square bg-slate-100 dark:bg-white/5">
                      {product.imageUrl ? <img src={product.imageUrl} alt="" className="h-full w-full object-cover" /> : null}
                    </div>
                    <div className="p-2.5">
                      <p className="truncate text-xs font-semibold">{product.offerId}</p>
                      <p className="mt-1 truncate text-[11px] text-slate-500">{product.storeName} · {product.imageCount} 图</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ListingQueueWorkspace() {
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlAction, setControlAction] =
    useState<QueueControlAction | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(
        "/api/listing-workflow/regenerate-upload-progress",
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message || "等待队列读取失败");
      }
      setProgress(payload.data);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 3_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const controlQueue = useCallback(
    async (action: QueueControlAction) => {
      setControlAction(action);
      try {
        const response = await fetch(
          "/api/listing-workflow/regenerate-upload-control",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        const payload = await response.json();
        if (!response.ok || !payload?.success) {
          throw new Error(payload?.error?.message || "队列操作失败");
        }
        toast.success(
          action === "pause"
            ? "已请求暂停，当前商品完成后停止"
            : action === "resume"
              ? "队列已继续运行"
              : "失败项已开始重试",
        );
        await refresh(true);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "队列操作失败");
      } finally {
        setControlAction(null);
      }
    },
    [refresh],
  );

  const data = progress ?? {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    percent: 0,
    batchStatus: "idle",
    paused: false,
    pauseRequested: false,
    pauseReason: "",
    pausedAt: "",
    currentOfferId: "",
    latestFailureOfferId: "",
    latestFailure: "",
    translationPaused: true,
    updatedAt: "",
    queueItems: [],
  };

  const cards = [
    { label: "已完成", value: data.completed, icon: CheckCircle2, color: "text-emerald-600" },
    { label: "处理中", value: data.running, icon: Loader2, color: "text-blue-600" },
    { label: "待处理", value: data.pending, icon: Clock3, color: "text-amber-600" },
    { label: "失败", value: data.failed, icon: AlertTriangle, color: "text-rose-600" },
  ];
  const queueActive =
    data.running > 0 || ["running", "starting"].includes(data.batchStatus);

  return (
    <div className="space-y-5">
      <CopiedProductImageQueue />
      <section className="rounded-3xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-6 dark:border-blue-400/20 dark:from-blue-500/10 dark:to-black/10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">主图重新生成并上传 Ozon</h2>
              {loading && !progress ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取状态
                </span>
              ) : null}
              {data.translationPaused ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-white/10 dark:text-slate-200">
                  <PauseCircle className="h-3.5 w-3.5" /> 图片翻译已暂停
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {data.pauseRequested
                ? "正在安全暂停，当前商品完成后停止"
                : data.paused
                ? `队列已暂停：${data.pauseReason || "等待恢复后继续"}`
                : data.running
                ? `正在处理：${data.currentOfferId || "当前商品"}`
                : data.completed + data.failed >= data.total && data.total
                  ? "当前队列已结束"
                  : "等待批处理继续运行"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {data.percent}%
            </span>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              刷新
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void controlQueue(data.paused ? "resume" : "pause")
              }
              disabled={
                Boolean(controlAction) ||
                data.pauseRequested ||
                (!data.paused && !queueActive)
              }
            >
              {controlAction === "pause" || controlAction === "resume" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : data.paused ? (
                <PlayCircle className="mr-2 h-4 w-4" />
              ) : (
                <PauseCircle className="mr-2 h-4 w-4" />
              )}
              {data.pauseRequested
                ? "正在暂停"
                : data.paused
                  ? "继续队列"
                  : "暂停队列"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void controlQueue("retry")}
              disabled={
                Boolean(controlAction) ||
                data.failed === 0 ||
                queueActive ||
                data.pauseRequested
              }
            >
              {controlAction === "retry" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              重试失败项
            </Button>
          </div>
        </div>
        <div className="mt-5 h-3 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950/60">
          <div
            className="h-full rounded-full bg-blue-600 transition-all duration-500"
            style={{ width: `${Math.min(data.percent, 100)}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{data.completed}/{data.total} 个商品</span>
          <span>
            {data.paused
              ? `暂停时间：${timeLabel(data.pausedAt)}`
              : `更新时间：${timeLabel(data.updatedAt)}`}
          </span>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-500 dark:text-slate-400">{card.label}</span>
                <Icon className={`h-5 w-5 ${card.color} ${card.label === "处理中" && data.running ? "animate-spin" : ""}`} />
              </div>
              <p className="mt-3 text-3xl font-bold">{card.value}</p>
            </div>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white/70 dark:border-white/10 dark:bg-black/20">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <h3 className="font-semibold">运行中与失败记录</h3>
        </div>
        {data.queueItems.filter((item) => item.status === "running" || item.status === "failed").length ? (
          <div className="divide-y divide-slate-200 dark:divide-white/10">
            {data.queueItems
              .filter((item) => item.status === "running" || item.status === "failed")
              .map((item) => (
                <div key={item.itemId} className="grid gap-2 px-5 py-4 md:grid-cols-[200px_90px_1fr_180px] md:items-center">
                  <span className="truncate text-sm font-medium">{item.offerId || item.itemId}</span>
                  <span className={`w-fit rounded-full px-2.5 py-1 text-xs font-medium ${item.status === "running" ? "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300" : "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"}`}>
                    {item.status === "running" ? "处理中" : "失败"}
                  </span>
                  <span className="truncate text-xs text-slate-500 dark:text-slate-400">{item.error || "正在重新生成并上传主图"}</span>
                  <span className="text-xs text-slate-400">{timeLabel(item.failedAt || item.startedAt)}</span>
                </div>
              ))}
          </div>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-slate-500">当前没有运行中或失败的任务</p>
        )}
      </section>
    </div>
  );
}
