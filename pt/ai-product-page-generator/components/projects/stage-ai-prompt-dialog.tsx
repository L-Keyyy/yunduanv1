"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ImageIcon, RotateCcw, Save, Split, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ListingStageAiPromptConfig } from "@/lib/listing-workflow/text-prompts";
import { normalizeListingStageAiPrompts } from "@/lib/listing-workflow/text-prompts";

const systemPromptLimit = 8000;
const taskPromptLimit = 4000;
const imagePromptLimit = 5000;

type StageKey = keyof ListingStageAiPromptConfig;

const stageMeta: Record<
  StageKey,
  {
    title: string;
    badge: string;
    description: string;
    jsonLabel: string;
  }
> = {
  categoryMatch: {
    title: "第一次发送给 AI：类目判断",
    badge: "第一阶段",
    description:
      "采集完成并选择 SKU 后，先把清洗后的商品事实发给 AI，让 AI 判断最合适的 Ozon 类目和 type。",
    jsonLabel: "商品事实 JSON 会由程序自动追加到任务提示词后面。",
  },
  featureFill: {
    title: "第二次发送给 AI：特征匹配",
    badge: "第二阶段",
    description:
      "类目确定后，程序读取该类目的 Ozon 特征表，再把商品事实、类目和字段模板发给 AI 填写特征值。",
    jsonLabel: "商品事实、匹配类目和 attributeTemplate JSON 会由程序自动追加。",
  },
  imageGeneration: {
    title: "主图生图提示词",
    badge: "图片阶段",
    description:
      "主图生成 / 改图模型会读取这段提示词；保存后主页手动生成和加工阶段自动生成都会使用。",
    jsonLabel: "当前主图会由程序按配置作为参考图传入，不需要把图片 URL 写进提示词。",
  },
};

function clonePromptConfig(value: ListingStageAiPromptConfig) {
  return {
    categoryMatch: {
      systemPrompt: value.categoryMatch.systemPrompt,
      taskPrompt: value.categoryMatch.taskPrompt,
    },
    featureFill: {
      systemPrompt: value.featureFill.systemPrompt,
      taskPrompt: value.featureFill.taskPrompt,
    },
    imageGeneration: {
      prompt: value.imageGeneration.prompt,
      aspectRatio: value.imageGeneration.aspectRatio,
      useReference: value.imageGeneration.useReference,
    },
  };
}

function promptConfigKey(value: ListingStageAiPromptConfig) {
  const normalized = normalizeListingStageAiPrompts(value);
  return JSON.stringify(normalized);
}

function PromptTextarea({
  label,
  value,
  limit,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  limit: number;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const tooLong = value.length > limit;
  return (
    <label className="block space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          {label}
        </span>
        <span
          className={`text-xs ${
            tooLong ? "text-rose-500" : "text-slate-400"
          }`}
        >
          {value.length} / {limit}
        </span>
      </div>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-[170px] resize-y text-sm leading-6"
      />
    </label>
  );
}

export function StageAiPromptDialog({
  open,
  value,
  defaultValue,
  onSave,
  onClose,
}: {
  open: boolean;
  value: ListingStageAiPromptConfig;
  defaultValue: ListingStageAiPromptConfig;
  onSave: (value: ListingStageAiPromptConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ListingStageAiPromptConfig>(() =>
    clonePromptConfig(value),
  );
  const [activeStage, setActiveStage] = useState<StageKey>("categoryMatch");

  useEffect(() => {
    if (!open) return;
    setDraft(clonePromptConfig(value));
    setActiveStage("categoryMatch");
  }, [open, value]);

  const normalizedDraft = useMemo(
    () => normalizeListingStageAiPrompts(draft),
    [draft],
  );
  const isDefault =
    promptConfigKey(normalizedDraft) === promptConfigKey(defaultValue);
  const changed = promptConfigKey(normalizedDraft) !== promptConfigKey(value);
  const hasInvalidPrompt =
    !normalizedDraft.categoryMatch.systemPrompt ||
    !normalizedDraft.categoryMatch.taskPrompt ||
    !normalizedDraft.featureFill.systemPrompt ||
    !normalizedDraft.featureFill.taskPrompt ||
    !normalizedDraft.imageGeneration.prompt ||
    normalizedDraft.categoryMatch.systemPrompt.length > systemPromptLimit ||
    normalizedDraft.featureFill.systemPrompt.length > systemPromptLimit ||
    normalizedDraft.categoryMatch.taskPrompt.length > taskPromptLimit ||
    normalizedDraft.featureFill.taskPrompt.length > taskPromptLimit ||
    normalizedDraft.imageGeneration.prompt.length > imagePromptLimit;

  if (!open || typeof document === "undefined") return null;

  const meta = stageMeta[activeStage];

  function updateStage<K extends StageKey>(
    stage: K,
    patch: Partial<ListingStageAiPromptConfig[K]>,
  ) {
    setDraft((current) => ({
      ...current,
      [stage]: {
        ...current[stage],
        ...patch,
      },
    }));
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="编辑 AI 提示词"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Bot className="h-5 w-5 text-rose-500" />
              <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
                AI 提示词
              </h2>
              <Badge variant={isDefault ? "success" : "warning"}>
                {isDefault ? "默认" : "自定义"}
              </Badge>
              {changed ? <Badge variant="warning">待保存</Badge> : null}
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              这里统一编辑并保存类目判断、特征匹配和主图生图提示词；商品 JSON、类目字段模板和参考图由程序自动追加。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭 AI 提示词"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-3 lg:grid-cols-3">
            {(["categoryMatch", "featureFill", "imageGeneration"] as StageKey[]).map((stage) => {
              const stageChanged =
                promptConfigKey({
                  ...defaultValue,
                  [stage]: normalizedDraft[stage],
                }) !==
                promptConfigKey({
                  ...defaultValue,
                  [stage]: defaultValue[stage],
                });
              return (
                <button
                  key={stage}
                  type="button"
                  onClick={() => setActiveStage(stage)}
                  className={`rounded-2xl border p-4 text-left transition ${
                    activeStage === stage
                      ? "border-slate-900 bg-slate-950 text-white shadow-lg dark:border-white dark:bg-white dark:text-slate-950"
                      : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {stage === "imageGeneration" ? (
                      <ImageIcon className="h-4 w-4" />
                    ) : (
                      <Split className="h-4 w-4" />
                    )}
                    <span className="text-sm font-semibold">
                      {stageMeta[stage].title}
                    </span>
                    {stageChanged ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                        已改
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs leading-5 opacity-75">
                    {stageMeta[stage].description}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{meta.badge}</Badge>
                  <h3 className="text-base font-semibold text-slate-950 dark:text-white">
                    {meta.title}
                  </h3>
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {meta.jsonLabel}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  updateStage(activeStage, clonePromptConfig(defaultValue)[activeStage])
                }
              >
                恢复本阶段默认
              </Button>
            </div>

            {activeStage === "imageGeneration" ? (
              <div className="mt-4 space-y-4">
                <PromptTextarea
                  label="主图生图提示词（prompt）"
                  value={normalizedDraft.imageGeneration.prompt}
                  limit={imagePromptLimit}
                  placeholder="输入主图生成提示词"
                  onChange={(nextValue) =>
                    updateStage("imageGeneration", { prompt: nextValue })
                  }
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>画幅</span>
                    <select
                      value={normalizedDraft.imageGeneration.aspectRatio}
                      onChange={(event) =>
                        updateStage("imageGeneration", {
                          aspectRatio: event.target.value as ListingStageAiPromptConfig["imageGeneration"]["aspectRatio"],
                        })
                      }
                      className="block h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none dark:border-white/10 dark:bg-black/20 dark:text-white"
                    >
                      <option value="1:1">1:1 主图</option>
                      <option value="3:4">3:4 竖图</option>
                      <option value="9:16">9:16 长图</option>
                    </select>
                  </label>
                  <label className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={normalizedDraft.imageGeneration.useReference}
                      onChange={(event) =>
                        updateStage("imageGeneration", {
                          useReference: event.target.checked,
                        })
                      }
                      className="h-4 w-4"
                    />
                    自动传入当前主图作为参考
                  </label>
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <PromptTextarea
                  label="系统提示词（systemPrompt）"
                  value={normalizedDraft[activeStage].systemPrompt}
                  limit={systemPromptLimit}
                  placeholder="输入系统提示词"
                  onChange={(nextValue) =>
                    updateStage(activeStage, { systemPrompt: nextValue })
                  }
                />
                <PromptTextarea
                  label="任务提示词（taskPrompt）"
                  value={normalizedDraft[activeStage].taskPrompt}
                  limit={taskPromptLimit}
                  placeholder="输入任务提示词"
                  onChange={(nextValue) =>
                    updateStage(activeStage, { taskPrompt: nextValue })
                  }
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft(clonePromptConfig(defaultValue))}
            disabled={isDefault}
            className="gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            全部恢复默认
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => onSave(normalizedDraft)}
              disabled={hasInvalidPrompt || !changed}
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              保存提示词
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
