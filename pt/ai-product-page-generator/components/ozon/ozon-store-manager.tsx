"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Save,
  Store,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OzonConnectionState } from "@/lib/ozon/client";
import type { ApiResponseShape } from "@/lib/utils/api";

type StoreListResponse = {
  stores: OzonConnectionState[];
  activeStoreId: string | null;
  activeStoreName: string;
};

function emptyStoreName(count: number) {
  return count ? `Ozon 店铺 ${count + 1}` : "Ozon 主店";
}

export function OzonStoreManager({
  onActiveStoreChange,
  selectedStoreIds,
  onSelectedStoreIdsChange,
  onStoresChange,
}: {
  onActiveStoreChange?: (store: OzonConnectionState) => void;
  selectedStoreIds: string[];
  onSelectedStoreIdsChange: (ids: string[]) => void;
  onStoresChange?: (stores: OzonConnectionState[]) => void;
}) {
  const [stores, setStores] = useState<OzonConnectionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"none" | "new" | "edit">("none");
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("Ozon 主店");
  const [baseUrl, setBaseUrl] = useState("https://api-seller.ozon.ru");
  const [clientId, setClientId] = useState("");
  const [apiKey, setApiKey] = useState("");

  async function readApi<T>(response: Response) {
    const payload = (await response.json()) as ApiResponseShape<T>;
    if (!payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "请求失败");
    }
    return payload.data;
  }

  function editStore(store: OzonConnectionState) {
    setEditorMode("edit");
    setEditingId(store.id ?? "");
    setName(store.name);
    setBaseUrl(store.baseUrl || "https://api-seller.ozon.ru");
    setClientId(store.clientId);
    setApiKey("");
  }

  async function addStore() {
    setBusy("add");
    try {
      const result = await readApi<{
        draft?: OzonConnectionState;
        stores: OzonConnectionState[];
      }>(
        await fetch("/api/ozon/configs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: emptyStoreName(stores.length) }),
        }),
      );
      setStores(result.stores);
      onStoresChange?.(result.stores);
      if (result.draft) editStore(result.draft);
      toast.success("新店铺已加入店铺管理，请继续填写 API 配置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "店铺添加失败");
    } finally {
      setBusy(null);
    }
  }

  async function loadStores(selectActive = true) {
    setLoading(true);
    try {
      const result = await readApi<StoreListResponse>(
        await fetch("/api/ozon/configs", { cache: "no-store" }),
      );
      setStores(result.stores);
      onStoresChange?.(result.stores);
      if (selectActive) setEditorMode("none");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStores().catch((error) =>
      toast.error(error instanceof Error ? error.message : "店铺读取失败"),
    );
  }, []);

  async function activateStore(store: OzonConnectionState) {
    if (!store.id || store.active) return;
    setBusy(`activate:${store.id}`);
    try {
      const result = await readApi<{
        connection: OzonConnectionState;
        stores: OzonConnectionState[];
      }>(
        await fetch(`/api/ozon/configs/${store.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "activate" }),
        }),
      );
      setStores(result.stores);
      onStoresChange?.(result.stores);
      editStore(result.connection);
      onActiveStoreChange?.(result.connection);
      toast.success(`当前店铺已切换为 ${result.connection.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "店铺切换失败");
    } finally {
      setBusy(null);
    }
  }

  async function saveStore() {
    setBusy("save");
    try {
      const result = await readApi<{
        savedConfigId: string;
        connection: OzonConnectionState;
        savedStore?: OzonConnectionState;
      }>(
        await fetch("/api/ozon/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editingId || undefined,
            name,
            baseUrl,
            clientId,
            apiKey,
          }),
        }),
      );
      setEditingId(result.savedConfigId);
      setApiKey("");
      await loadStores(false);
      const savedStore = result.savedStore ?? result.connection;
      editStore(savedStore);
      if (!selectedStoreIds.includes(result.savedConfigId)) {
        onSelectedStoreIdsChange([...selectedStoreIds, result.savedConfigId]);
      }
      toast.success(`${savedStore.name} 已保存，其他店铺配置保持不变`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "店铺保存失败");
    } finally {
      setBusy(null);
    }
  }

  const editingStore = stores.find((store) => store.id === editingId);
  const apiKeyRequired = !editingStore?.apiKeyConfigured;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-950 dark:text-white">
            已添加 {stores.length} 个 Ozon Seller 店铺
          </p>
          <p className="mt-1 text-xs text-slate-500">
            所有店铺同时保留；勾选一个或多个“上架目标”即可批量提交到多个店铺。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void addStore()}
          disabled={Boolean(busy)}
        >
          {busy === "add" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          添加店铺
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-28 items-center justify-center text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在读取店铺
        </div>
      ) : stores.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((store) => (
            <div
              key={store.id ?? store.name}
              className={`rounded-2xl border p-4 ${
                store.active
                  ? "border-slate-950 bg-slate-950 text-white dark:border-white dark:bg-white dark:text-slate-950"
                  : "border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Store className="h-4 w-4 shrink-0" />
                    <p className="truncate text-sm font-semibold">{store.name}</p>
                  </div>
                  <p className={`mt-2 text-xs ${store.active ? "opacity-75" : "text-slate-500"}`}>
                    Client-Id：{store.maskedClientId || "-"}
                  </p>
                </div>
                {store.active ? (
                  <Badge variant="success">
                    <CheckCircle2 className="mr-1 h-3 w-3" />默认
                  </Badge>
                ) : !store.ready ? (
                  <Badge variant="warning">待配置</Badge>
                ) : null}
              </div>
              <div className="mt-4 flex gap-2">
                {store.id ? (
                  <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-xs font-medium ${store.active ? "border-white/30 dark:border-slate-300" : "border-slate-200 dark:border-white/10"}`}>
                    <input
                      type="checkbox"
                      checked={selectedStoreIds.includes(store.id)}
                      disabled={!store.ready}
                      onChange={(event) =>
                        onSelectedStoreIdsChange(
                          event.target.checked
                            ? [...new Set([...selectedStoreIds, store.id as string])]
                            : selectedStoreIds.filter((id) => id !== store.id),
                        )
                      }
                    />
                    {store.ready ? "上架目标" : "配置后可选"}
                  </label>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={store.active ? "secondary" : "outline"}
                  onClick={() => void activateStore(store)}
                  disabled={store.active || Boolean(busy) || !store.id || !store.ready}
                >
                  {busy === `activate:${store.id}` ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {store.active ? "默认店铺" : "设为默认"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => editStore(store)}
                  disabled={Boolean(busy) || !store.id}
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />编辑
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {editorMode !== "none" ? (
      <div className="rounded-2xl border border-slate-200 p-4 dark:border-white/10">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-950 dark:text-white">
            配置这个店铺
            </p>
            <p className="mt-1 text-xs text-slate-500">
              每个店铺使用独立的 Client-Id 和 Api-Key；密钥加密保存在本地。
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500">店铺名称</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：俄罗斯主店" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500">API 地址</span>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500">Client-Id</span>
            <Input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Ozon Seller Client-Id" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500">Api-Key</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={apiKeyRequired ? "Ozon Seller Api-Key" : "保持原密钥可留空"}
              autoComplete="new-password"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            onClick={() => void saveStore()}
            disabled={
              Boolean(busy) ||
              !editingId ||
              !name.trim() ||
              !clientId.trim() ||
              (apiKeyRequired && apiKey.trim().length < 6)
            }
          >
            {busy === "save" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存这个店铺
          </Button>
        </div>
      </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-8 text-center text-sm text-slate-500 dark:border-white/15">
          点击“添加店铺”会立即新增一张待填写的店铺卡片；点击已有店铺的“编辑”可修改对应配置。
        </div>
      )}
    </div>
  );
}
