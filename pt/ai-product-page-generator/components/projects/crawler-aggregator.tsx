"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Cookie, ExternalLink, Loader2, Play, RefreshCw, Search, ShoppingBag, Store } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CrawlerModule, CrawlerScanResult } from "@/lib/crawlers/registry";
import type { ApiResponseShape } from "@/lib/utils/api";

const platformActions = [
  { id: "launch_taobao_spider", label: "淘宝", icon: ShoppingBag },
  { id: "launch_jd_spider", label: "京东", icon: Store },
  { id: "launch_1688_spider", label: "1688", icon: Search },
  { id: "launch_cookie_helper", label: "Cookie", icon: Cookie },
];

async function readApi<T>(response: Response) {
  const payload = (await response.json()) as ApiResponseShape<T>;
  if (!payload.success || !payload.data) {
    throw new Error(payload.error?.message ?? "请求失败");
  }
  return payload.data;
}

function statusBadge(status: CrawlerModule["status"]) {
  if (status === "ready") return <Badge variant="success">可用</Badge>;
  if (status === "partial") return <Badge variant="warning">部分可用</Badge>;
  return <Badge variant="destructive">缺失</Badge>;
}

export function CrawlerAggregator() {
  const [scan, setScan] = useState<CrawlerScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const primary = useMemo(() => scan?.modules.find((module) => module.id === "marketspider-main") ?? null, [scan]);
  const backup = useMemo(() => scan?.modules.find((module) => module.id === "marketspider-pt") ?? null, [scan]);

  async function refresh() {
    setLoading(true);
    try {
      setScan(await readApi<CrawlerScanResult>(await fetch("/api/crawlers")));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "扫描爬虫失败");
    } finally {
      setLoading(false);
    }
  }

  async function launch(action: string) {
    setBusyAction(action);
    try {
      const result = await readApi<{ url: string | null }>(
        await fetch("/api/crawlers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      );
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      toast.success("爬虫已启动");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动失败");
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const resultOutput = primary?.outputs.find((output) => output.label === "采集结果");
  const cookieOutput = primary?.outputs.find((output) => output.label === "登录缓存");

  return (
    <section className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-slate-900 dark:text-white">采集数据</p>
            {primary ? statusBadge(primary.status) : <Badge variant="warning">扫描中</Badge>}
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            聚合本地 MarketSpider 的淘宝、京东、1688 爬虫；结果会落在原项目的 result 目录。
          </p>
        </div>
        <Button type="button" variant="outline" onClick={refresh} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          刷新
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        {platformActions.map((action) => {
          const Icon = action.icon;
          const enabled = primary?.actions.find((item) => item.id === action.id)?.enabled ?? false;
          return (
            <button
              key={action.id}
              type="button"
              onClick={() => launch(action.id)}
              disabled={!enabled || busyAction !== null}
              className="flex min-h-[88px] flex-col items-start justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:bg-black/20"
            >
              <div className="flex w-full items-center justify-between gap-2">
                <Icon className="h-5 w-5 text-slate-700 dark:text-slate-200" />
                {busyAction === action.id ? (
                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                ) : enabled ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : null}
              </div>
              <span className="text-sm font-semibold text-slate-900 dark:text-white">启动{action.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => launch("launch_marketspider_ui")}
          disabled={!(primary?.actions.find((item) => item.id === "launch_marketspider_ui")?.enabled ?? false) || busyAction !== null}
          className="gap-2"
        >
          {busyAction === "launch_marketspider_ui" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          打开 MarketSpider 控制台
        </Button>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 dark:border-white/10 dark:bg-black/20 dark:text-slate-400">
          <Play className="h-3.5 w-3.5" />
          {primary?.baseDir ?? "正在扫描脚本目录"}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
          <p className="text-xs text-slate-400">采集结果</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{resultOutput?.count ?? 0}</p>
          <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{resultOutput?.path ?? "-"}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
          <p className="text-xs text-slate-400">Cookie 缓存</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{cookieOutput?.count ?? 0}</p>
          <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{cookieOutput?.path ?? "-"}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
          <p className="text-xs text-slate-400">备用目录</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{backup?.status === "ready" ? "可用" : "未启用"}</p>
          <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{backup?.baseDir ?? "-"}</p>
        </div>
      </div>

      {resultOutput?.latest.length ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">最近结果</p>
          <div className="mt-3 space-y-2">
            {resultOutput.latest.map((file) => (
              <div key={file.path} className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                <span className="truncate">{file.name}</span>
                <span>{new Date(file.modifiedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
