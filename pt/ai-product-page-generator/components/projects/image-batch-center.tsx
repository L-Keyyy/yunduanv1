"use client";

import { CheckCircle2, ChevronDown, ChevronUp, LoaderCircle, Pause, Play, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: { message: string } | null;
};

type ListingItem = {
  id: string;
  title: string;
  offerId: string;
  imageUrl: string | null;
  sourceUrl: string | null;
  scrapedData: unknown;
};

type ImageTask = {
  id: string;
  type: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  resultImageUrl: string | null;
  errorMessage: string | null;
};

type BatchProduct = {
  id: string;
  title: string;
  status: string;
  totalTasks: number;
  succeededTasks: number;
  failedTasks: number;
  imageTasks: ImageTask[];
};

type ImageBatch = {
  id: string;
  name: string;
  status: string;
  model: string;
  totalProducts: number;
  totalTasks: number;
  succeededTasks: number;
  failedTasks: number;
  maxConcurrency: number;
  createdAt: string;
  products?: BatchProduct[];
};

const activeStatuses = new Set(["PENDING", "RUNNING"]);

const statusLabels: Record<string, string> = {
  PENDING: "等待中",
  RUNNING: "处理中",
  PAUSED: "已暂停",
  SUCCESS: "已完成",
  PARTIAL: "部分完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  RETRYING: "重试中",
};

function statusVariant(status: string): "default" | "success" | "warning" | "destructive" | "outline" {
  if (status === "SUCCESS") return "success";
  if (status === "FAILED" || status === "CANCELLED") return "destructive";
  if (status === "RUNNING" || status === "RETRYING" || status === "PARTIAL") return "warning";
  return "default";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractImages(item: ListingItem) {
  const data = objectValue(item.scrapedData);
  const candidates: unknown[] = [];
  if (item.imageUrl) candidates.push(item.imageUrl);
  if (Array.isArray(data?.images)) candidates.push(...data.images);
  if (Array.isArray(data?.imageUrls)) candidates.push(...data.imageUrls);
  const gallery = objectValue(data?.gallery);
  if (Array.isArray(gallery?.images)) {
    candidates.push(
      ...gallery.images.map((entry) => (typeof entry === "string" ? entry : objectValue(entry)?.src)),
    );
  }
  return Array.from(new Set(candidates.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

async function readApi<T>(response: Response) {
  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(payload.error?.message || `请求失败：${response.status}`);
  }
  return payload.data;
}

export function ImageBatchCenter() {
  const [items, setItems] = useState<ListingItem[]>([]);
  const [batches, setBatches] = useState<ImageBatch[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [batchDetail, setBatchDetail] = useState<ImageBatch | null>(null);
  const [name, setName] = useState(`豆包批量图片-${new Date().toLocaleDateString("zh-CN")}`);
  const [prompt, setPrompt] = useState("基于参考图为 {{title}} 生成适合 Ozon 的高质量商品图，保持商品主体、结构、颜色和关键细节准确，画面整洁，文字清晰。第 {{index}} 张。");
  const [imageMode, setImageMode] = useState<"main" | "all">("main");
  const [maxImages, setMaxImages] = useState(6);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadItems = useCallback(async () => {
    const data = await readApi<ListingItem[]>(await fetch("/api/listing-workflow/items", { cache: "no-store" }));
    setItems(data);
  }, []);

  const loadBatches = useCallback(async () => {
    const data = await readApi<ImageBatch[]>(await fetch("/api/image-batches", { cache: "no-store" }));
    setBatches(data);
    return data;
  }, []);

  const loadDetail = useCallback(async (batchId: string) => {
    const data = await readApi<ImageBatch>(await fetch(`/api/image-batches/${batchId}`, { cache: "no-store" }));
    setBatchDetail(data);
    return data;
  }, []);

  useEffect(() => {
    void Promise.all([loadItems(), loadBatches()])
      .catch((error) => toast.error(error instanceof Error ? error.message : "数据加载失败"))
      .finally(() => setLoading(false));
  }, [loadBatches, loadItems]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadBatches().then((current) => {
        if (expandedBatchId && current.some((batch) => activeStatuses.has(batch.status))) {
          void loadDetail(expandedBatchId);
        }
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [expandedBatchId, loadBatches, loadDetail]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );

  const taskCount = useMemo(
    () => selectedItems.reduce((sum, item) => sum + (imageMode === "main" ? 1 : Math.max(1, Math.min(extractImages(item).length, maxImages))), 0),
    [imageMode, maxImages, selectedItems],
  );

  function toggleItem(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createBatch() {
    if (selectedItems.length === 0) {
      toast.error("请先选择至少一个商品");
      return;
    }
    setSubmitting(true);
    try {
      const products = selectedItems.map((item) => {
        const sources = extractImages(item);
        const taskSources = imageMode === "main" ? sources.slice(0, 1) : sources.slice(0, maxImages);
        const normalizedSources = taskSources.length > 0 ? taskSources : [undefined];
        return {
          listingWorkflowItemId: item.id,
          offerId: item.offerId,
          title: item.title,
          sourceUrl: item.sourceUrl || undefined,
          sourceImageUrl: sources[0],
          images: normalizedSources.map((source, index) => ({
            type: index === 0 ? "GENERATE_MAIN" : "GENERATE_DETAIL",
            referenceImages: source ? [source] : [],
            priority: index === 0 ? 10 : 0,
          })),
        };
      });
      const batch = await readApi<ImageBatch>(
        await fetch("/api/image-batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            providerId: "browser-webai",
            model: "doubao-image-web",
            prompt,
            aspectRatio: "1:1",
            maxConcurrency: 1,
            maxAttempts: 3,
            products,
          }),
        }),
      );
      setExpandedBatchId(batch.id);
      setBatchDetail(batch);
      setSelectedIds(new Set());
      await loadBatches();
      toast.success(`已创建 ${batch.totalTasks} 个图片任务`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建批次失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function control(batchId: string, action: "pause" | "resume" | "retry_failed" | "cancel") {
    try {
      const detail = await readApi<ImageBatch>(
        await fetch(`/api/image-batches/${batchId}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      );
      setBatchDetail(detail);
      await loadBatches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  async function toggleDetail(batchId: string) {
    if (expandedBatchId === batchId) {
      setExpandedBatchId(null);
      setBatchDetail(null);
      return;
    }
    setExpandedBatchId(batchId);
    try {
      await loadDetail(batchId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "详情加载失败");
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>1. 选择商品与图片范围</CardTitle>
          <CardDescription>已选 {selectedItems.length} 个商品，将创建 {taskCount} 个持久化图片任务。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="batch-name">批次名称</Label>
              <Input id="batch-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-mode">处理范围</Label>
              <select
                id="image-mode"
                className="h-10 w-full rounded-xl border border-input bg-white px-3 text-sm dark:bg-white/6"
                value={imageMode}
                onChange={(event) => setImageMode(event.target.value as "main" | "all")}
              >
                <option value="main">每个商品只处理主图</option>
                <option value="all">每个商品处理多张采集图</option>
              </select>
            </div>
          </div>
          {imageMode === "all" ? (
            <div className="max-w-xs space-y-2">
              <Label htmlFor="max-images">每个商品最多图片数</Label>
              <Input id="max-images" type="number" min={1} max={20} value={maxImages} onChange={(event) => setMaxImages(Math.min(20, Math.max(1, Number(event.target.value) || 1)))} />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="batch-prompt">豆包图片提示词</Label>
            <Textarea id="batch-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <p className="text-xs text-muted-foreground">变量：{"{{title}}"} 商品标题、{"{{offerId}}"} 商品编号、{"{{index}}"} 图片序号。</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set(items.map((item) => item.id)))}>全选</Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>清空</Button>
            </div>
            <Button onClick={createBatch} disabled={submitting || selectedItems.length === 0 || prompt.trim().length < 4}>
              {submitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              启动豆包批处理
            </Button>
          </div>
          <div className="max-h-[430px] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 p-2 dark:border-white/10">
            {loading ? <p className="p-4 text-sm text-muted-foreground">正在加载商品…</p> : null}
            {!loading && items.length === 0 ? <p className="p-4 text-sm text-muted-foreground">采集阶段还没有商品。</p> : null}
            {items.map((item) => {
              const images = extractImages(item);
              return (
                <label key={item.id} className="flex cursor-pointer items-center gap-3 rounded-xl p-3 hover:bg-slate-50 dark:hover:bg-white/5">
                  <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleItem(item.id)} />
                  {images[0] ? <img src={images[0]} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="h-12 w-12 rounded-lg bg-slate-100 dark:bg-white/10" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="text-xs text-muted-foreground">货号 {item.offerId} · {images.length} 张图</span>
                  </span>
                </label>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>2. 批次进度与结果</CardTitle>
            <CardDescription>浏览器豆包任务固定单并发，API 图片模型批次可扩展到 4 并发。</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadBatches()}><RefreshCw className="mr-2 h-4 w-4" />刷新</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {batches.length === 0 ? <p className="text-sm text-muted-foreground">还没有批次。</p> : null}
          {batches.map((batch) => {
            const progress = batch.totalTasks ? Math.round((batch.succeededTasks / batch.totalTasks) * 100) : 0;
            const expanded = expandedBatchId === batch.id;
            return (
              <div key={batch.id} className="rounded-2xl border border-slate-200 p-4 dark:border-white/10">
                <div className="flex flex-wrap items-center gap-3">
                  <button className="min-w-0 flex-1 text-left" onClick={() => void toggleDetail(batch.id)}>
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{batch.name}</span>
                      <Badge variant={statusVariant(batch.status)}>{statusLabels[batch.status] || batch.status}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{batch.totalProducts} 个商品 · {batch.succeededTasks}/{batch.totalTasks} 完成 · {batch.failedTasks} 失败</span>
                  </button>
                  {batch.status === "RUNNING" || batch.status === "PENDING" ? <Button variant="outline" size="sm" onClick={() => void control(batch.id, "pause")}><Pause className="mr-1 h-4 w-4" />暂停</Button> : null}
                  {batch.status === "PAUSED" ? <Button variant="outline" size="sm" onClick={() => void control(batch.id, "resume")}><Play className="mr-1 h-4 w-4" />继续</Button> : null}
                  {batch.failedTasks > 0 ? <Button variant="outline" size="sm" onClick={() => void control(batch.id, "retry_failed")}><RotateCcw className="mr-1 h-4 w-4" />重试失败</Button> : null}
                  {activeStatuses.has(batch.status) || batch.status === "PAUSED" ? <Button variant="ghost" size="sm" onClick={() => void control(batch.id, "cancel")}><XCircle className="mr-1 h-4 w-4" />取消</Button> : null}
                  <Button variant="ghost" size="sm" onClick={() => void toggleDetail(batch.id)}>{expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} /></div>
                {expanded && batchDetail?.id === batch.id ? (
                  <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
                    {batchDetail.products?.map((product) => (
                      <div key={product.id} className="rounded-xl bg-slate-50 p-3 dark:bg-white/5">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-medium">{product.title}</p>
                          <Badge variant={statusVariant(product.status)}>{statusLabels[product.status] || product.status}</Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-3">
                          {product.imageTasks.map((task) => (
                            <div key={task.id} className="w-28 space-y-1">
                              {task.resultImageUrl ? (
                                <a href={task.resultImageUrl} target="_blank" rel="noreferrer"><img src={task.resultImageUrl} alt="生成结果" className="h-28 w-28 rounded-lg object-cover" /></a>
                              ) : (
                                <div className="flex h-28 w-28 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
                                  {task.status === "RUNNING" || task.status === "RETRYING" ? <LoaderCircle className="h-5 w-5 animate-spin" /> : task.status === "FAILED" ? <XCircle className="h-5 w-5 text-rose-500" /> : <CheckCircle2 className="h-5 w-5" />}
                                </div>
                              )}
                              <p className="truncate text-[11px] text-muted-foreground">{statusLabels[task.status] || task.status} · {task.attempt}/{task.maxAttempts}</p>
                              {task.errorMessage ? <p className="line-clamp-2 text-[11px] text-rose-600" title={task.errorMessage}>{task.errorMessage}</p> : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
