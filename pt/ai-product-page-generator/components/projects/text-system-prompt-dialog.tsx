"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Save, ShieldCheck, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function TextSystemPromptDialog({
  open,
  value,
  defaultValue,
  onSave,
  onClose,
}: {
  open: boolean;
  value: string;
  defaultValue: string;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  if (!open) return null;

  const normalizedDraft = draft.trim();
  const isDefault = normalizedDraft === defaultValue.trim();
  const changed = normalizedDraft !== value.trim();

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="编辑系统提示词"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-rose-500" />
              <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
                系统提示词
              </h2>
              <Badge variant={isDefault ? "success" : "warning"}>
                {isDefault ? "默认" : "自定义"}
              </Badge>
              {changed ? <Badge variant="warning">待保存</Badge> : null}
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              每次处理爬虫 JSON 时都会先发送这段要求；API 模型使用 system role，浏览器模型会放在用户任务之前。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭系统提示词"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <Textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入文本模型的系统提示词"
            className="min-h-[260px] resize-y text-sm leading-6"
          />
          <p className="mt-2 text-right text-xs text-slate-400">
            {draft.length} / 8000
          </p>
        </div>

        <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft(defaultValue)}
            disabled={isDefault}
            className="gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            恢复默认
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => onSave(normalizedDraft)}
              disabled={!normalizedDraft || normalizedDraft.length > 8000 || !changed}
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              保存系统提示词
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
