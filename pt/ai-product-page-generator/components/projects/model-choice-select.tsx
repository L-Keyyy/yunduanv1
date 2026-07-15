"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type ModelChoiceSelectOption = {
  value: string;
  label: string;
  isBrowser: boolean;
};

function ModelLabel({
  isBrowser,
  label,
}: {
  isBrowser: boolean;
  label: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {isBrowser ? (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-rose-200 bg-rose-50 px-1 text-xs font-black lowercase text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          b
        </span>
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ModelChoiceSelect({
  value,
  onValueChange,
  options,
  placeholder,
  ariaLabel,
  emptyLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: ModelChoiceSelectOption[];
  placeholder: string;
  ariaLabel?: string;
  emptyLabel: string;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);

  if (!options.length) {
    return (
      <div
        className={cn(
          "flex h-11 w-full items-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-400 dark:border-white/10 dark:bg-black/20 dark:text-slate-500",
          className,
        )}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <Select.Root value={value || undefined} onValueChange={onValueChange}>
      <Select.Trigger
        aria-label={ariaLabel || placeholder}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 text-left text-sm text-slate-900 outline-none transition-colors hover:border-slate-300 focus:ring-2 focus:ring-slate-300/50 dark:border-white/10 dark:bg-black/20 dark:text-white dark:hover:border-white/20",
          className,
        )}
      >
        <span className="min-w-0 flex-1">
          {selected ? (
            <ModelLabel isBrowser={selected.isBrowser} label={selected.label} />
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
        </span>
        <Select.Icon>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={6}
          className="z-[100] max-h-80 w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-slate-950"
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-pointer select-none items-center rounded-lg py-2.5 pl-3 pr-9 text-sm text-slate-700 outline-none data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-950 dark:text-slate-200 dark:data-[highlighted]:bg-white/10 dark:data-[highlighted]:text-white"
              >
                <Select.ItemText>
                  <ModelLabel isBrowser={option.isBrowser} label={option.label} />
                </Select.ItemText>
                <Select.ItemIndicator className="absolute right-3 inline-flex items-center">
                  <Check className="h-4 w-4" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
