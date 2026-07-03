"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, DatabaseZap, KeyRound, Loader2, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OzonConnectionState } from "@/lib/ozon/client";
import type { ApiResponseShape } from "@/lib/utils/api";

type SaveResponse = {
  savedConfigId: string;
  connection: OzonConnectionState;
};

type SyncResponse = {
  categoriesSynced?: number;
};

export function OzonApiConfigPanel(props: {
  connection: OzonConnectionState;
  onConnectionChange?: (connection: OzonConnectionState) => void;
  onSynced?: () => Promise<void> | void;
}) {
  const [configId, setConfigId] = useState(props.connection.id ?? "");
  const [name, setName] = useState(props.connection.source === "missing" ? "Ozon Seller API" : props.connection.name);
  const [baseUrl, setBaseUrl] = useState(props.connection.baseUrl || "https://api-seller.ozon.ru");
  const [clientId, setClientId] = useState(props.connection.clientId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "sync" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState(props.connection);

  useEffect(() => {
    setConnection(props.connection);
    setConfigId(props.connection.id ?? "");
    setName(props.connection.source === "missing" ? "Ozon Seller API" : props.connection.name);
    setBaseUrl(props.connection.baseUrl || "https://api-seller.ozon.ru");
    setClientId(props.connection.clientId ?? "");
    setApiKey("");
  }, [props.connection]);

  async function readApi<T>(response: Response) {
    const payload = (await response.json()) as ApiResponseShape<T>;
    if (!payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "请求失败");
    }
    return payload.data;
  }

  async function saveConfig() {
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      const result = await readApi<SaveResponse>(
        await fetch("/api/ozon/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: configId || undefined,
            name,
            baseUrl,
            clientId,
            apiKey,
          }),
        }),
      );
      setConfigId(result.savedConfigId);
      setApiKey("");
      setConnection(result.connection);
      props.onConnectionChange?.(result.connection);
      setMessage("Ozon API 配置已保存。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setBusy(null);
    }
  }

  async function syncCategoryTree() {
    setBusy("sync");
    setError(null);
    setMessage(null);
    try {
      const result = await readApi<SyncResponse>(
        await fetch("/api/ozon/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "category_tree", language: "DEFAULT" }),
        }),
      );
      await props.onSynced?.();
      setMessage(`Ozon 类目树同步完成：${String(result.categoriesSynced ?? 0)} 个节点。`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "同步失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-slate-500" />
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Ozon API 配置</p>
            <Badge variant={connection.ready ? "success" : "warning"}>{connection.ready ? "已配置" : "待配置"}</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            用于同步 Ozon 类目树、类目属性和字典值。Api-Key 会加密保存在本地。
          </p>
        </div>
        {connection.ready ? (
          <div className="text-right text-xs leading-5 text-slate-500 dark:text-slate-400">
            <p>{connection.name}</p>
            <p>Client-Id：{connection.maskedClientId || "-"}</p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">配置名称</label>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：主店 Ozon API" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">API 地址</label>
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api-seller.ozon.ru" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Client-Id</label>
          <Input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Ozon Seller Client-Id" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Api-Key</label>
          <Input
            value={apiKey}
            type="password"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={configId ? "不修改可留空" : "Ozon Seller Api-Key"}
            autoComplete="new-password"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" onClick={saveConfig} disabled={busy !== null} className="gap-2">
          {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          保存配置
        </Button>
        <Button type="button" variant="outline" onClick={syncCategoryTree} disabled={!connection.ready || busy !== null} className="gap-2">
          {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}
          同步类目树
        </Button>
      </div>

      {message ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{message}</span>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
