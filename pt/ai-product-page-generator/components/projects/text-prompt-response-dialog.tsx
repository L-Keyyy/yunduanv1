"use client";

import { Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OzonAiMapping } from "@/lib/ozon/ai-response-mapper";

export type TextPromptResponse = {
  text: string;
  providerId: string;
  providerName: string;
  model: string;
  generatedAt: string;
  ozonMapping?: OzonAiMapping | null;
};

function generatedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function TextPromptResponseDialog({
  open,
  loading,
  response,
  error,
  onClose,
}: {
  open: boolean;
  loading: boolean;
  response: TextPromptResponse | null;
  error: string | null;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="文本模型回答"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
                文本模型回答
              </h2>
              <Badge
                variant={
                  loading ? "warning" : error ? "destructive" : "success"
                }
              >
                {loading ? "生成中" : error ? "失败" : response ? "已返回" : "暂无回答"}
              </Badge>
            </div>
            {response ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {response.providerName} / {response.model} /{" "}
                {generatedTime(response.generatedAt)}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭回答"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin" />
              正在把提示词和爬虫 JSON 发送给所选模型…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
              {error}
            </div>
          ) : response ? (
            <div className="space-y-3">
              {response.ozonMapping ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
                  <p className="font-semibold">已识别并自动应用 Ozon JSON</p>
                  <p className="mt-1 text-xs leading-5 opacity-80">
                    基础信息 {response.ozonMapping.baseFields.length} 项 / 商品特征 {response.ozonMapping.attributes.length} 项
                    {response.ozonMapping.category.descriptionCategoryId
                      ? ` / 类目 ${response.ozonMapping.category.descriptionCategoryId}`
                      : ""}
                    {response.ozonMapping.category.typeId
                      ? ` / Type ${response.ozonMapping.category.typeId}`
                      : ""}
                    {response.ozonMapping.variants.length
                      ? ` / SKU ${response.ozonMapping.variants.length} 个`
                      : ""}
                  </p>
                  {response.ozonMapping.warnings.length ? (
                    <div className="mt-2 text-xs leading-5">
                      {response.ozonMapping.warnings.map((warning) => (
                        <p key={warning}>- {warning}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-4 font-sans text-sm leading-7 text-slate-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100">
                {response.text}
              </pre>
            </div>
          ) : (
            <div className="flex min-h-48 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              爬虫成功抓取 JSON 后，会自动生成回答并显示在这里。
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <Button type="button" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
