"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  DatabaseZap,
  FileJson2,
  Loader2,
  PencilLine,
  RefreshCw,
  Search,
  Sparkles,
  TreePine,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { OzonApiConfigPanel } from "@/components/ozon/ozon-api-config-panel";
import {
  deepseekMappingContract,
  ozonListingBaseFields,
  sampleSourceModules,
  type OzonAttributeNode,
  type OzonMappedFeature,
} from "@/lib/ozon/feature-tree";
import type { OzonAttributeSnapshot, OzonFeatureSnapshot } from "@/lib/ozon/snapshot";
import type { ApiResponseShape } from "@/lib/utils/api";
import { cn } from "@/lib/utils";

type BusyAction = "cache" | "tree" | "attributes" | "search" | null;

const statusMeta: Record<OzonMappedFeature["status"], { label: string; variant: "success" | "warning" | "destructive" | "outline" }> = {
  auto: { label: "自动填写", variant: "success" },
  review: { label: "待人工复核", variant: "warning" },
  missing: { label: "缺失必填", variant: "destructive" },
  special: { label: "特殊规则", variant: "outline" },
};

function flattenAttributes(nodes: OzonAttributeNode[]): OzonAttributeNode[] {
  return nodes.flatMap((node) => [node, ...flattenAttributes(node.children ?? [])]);
}

function confidenceColor(value: number) {
  if (value >= 0.8) return "text-emerald-600 dark:text-emerald-300";
  if (value >= 0.55) return "text-amber-600 dark:text-amber-300";
  return "text-rose-600 dark:text-rose-300";
}

function AttributeTree({ node }: { node: OzonAttributeNode }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-white">{node.label}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{node.aiHint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={node.requirement === "required" ? "destructive" : node.requirement === "conditional" ? "warning" : "outline"}>
            {node.requirement === "required" ? "必填" : node.requirement === "conditional" ? "条件必填" : "建议"}
          </Badge>
          {node.humanReview ? <Badge variant="outline">可人工改</Badge> : null}
        </div>
      </div>
      {node.children?.length ? (
        <ul className="mt-3 space-y-2 border-l border-slate-200 pl-3 dark:border-white/10">
          {node.children.map((child) => (
            <AttributeTree key={child.id} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function groupAttributes(attributes: OzonAttributeSnapshot[]) {
  return attributes.reduce<Record<string, OzonAttributeSnapshot[]>>((groups, attribute) => {
    const key = attribute.groupName || "未分组属性";
    groups[key] = groups[key] ?? [];
    groups[key].push(attribute);
    return groups;
  }, {});
}

function buildDraftFeatures(attributes: OzonAttributeSnapshot[]): OzonMappedFeature[] {
  return attributes
    .filter((attribute) => attribute.isRequired || attribute.dictionaryId || attribute.categoryDependent)
    .slice(0, 80)
    .map((attribute) => {
      const status: OzonMappedFeature["status"] = attribute.isRequired
        ? "missing"
        : attribute.categoryDependent
          ? "special"
          : "review";
      const reason = attribute.isRequired
        ? "Ozon 同步表标记 is_required=true，抓取模块还没有给出可直接入库的可靠值。"
        : attribute.categoryDependent
          ? "该属性随类目/类型变化，需要特殊规则或人工确认。"
          : "该属性绑定 Ozon 字典值，DeepSeek 只能从已同步字典中匹配。";

      return {
        attributeId: attribute.ozonAttributeId,
        label: attribute.name,
        value: "",
        confidence: attribute.isRequired ? 0.28 : 0.5,
        sourceModuleIds: [],
        status,
        reason,
      };
    });
}

async function readApi<T>(response: Response) {
  const payload = (await response.json()) as ApiResponseShape<T>;
  if (!payload.success || !payload.data) {
    throw new Error(payload.error?.message ?? "请求失败");
  }
  return payload.data;
}

export function OzonFeatureMapper({ initialSnapshot }: { initialSnapshot: OzonFeatureSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedCategoryId, setSelectedCategoryId] = useState(initialSnapshot.selectedCategory?.id ?? "");
  const [query, setQuery] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const baseFlat = useMemo(() => flattenAttributes(ozonListingBaseFields), []);
  const selectedCategory = snapshot.selectedCategory;
  const categoryAttributes = selectedCategory?.attributes ?? [];
  const groupedAttributes = useMemo(() => groupAttributes(categoryAttributes), [categoryAttributes]);
  const draftFeatures = useMemo(() => buildDraftFeatures(categoryAttributes), [categoryAttributes]);
  const ready = snapshot.connection.ready;
  const reviewCount = draftFeatures.filter((item) => item.status !== "auto").length;

	  async function loadSnapshot(categoryId = selectedCategoryId, search = query) {
    const params = new URLSearchParams();
    if (categoryId) params.set("categoryId", categoryId);
    if (search.trim()) params.set("q", search.trim());

    const nextSnapshot = await readApi<OzonFeatureSnapshot>(await fetch(`/api/ozon/features?${params.toString()}`));
    setSnapshot(nextSnapshot);
    setSelectedCategoryId(nextSnapshot.selectedCategory?.id ?? "");
	  }

	  function handleConnectionChange(connection: OzonFeatureSnapshot["connection"]) {
	    setSnapshot((current) => ({
	      ...current,
	      connection,
	    }));
	  }

  async function runSync(action: "ozon_hd_cache_import" | "category_tree" | "category_attributes") {
    setBusyAction(action === "ozon_hd_cache_import" ? "cache" : action === "category_tree" ? "tree" : "attributes");
    setError(null);
    setNotice(null);

    try {
      const body =
        action === "ozon_hd_cache_import"
          ? { action, includeAttributes: true, includeValues: true }
          : action === "category_tree"
            ? { action, language: "DEFAULT" }
            : {
                action,
              categoryRecordId: selectedCategoryId,
              includeValues: true,
              language: "DEFAULT",
              maxValuesPerAttribute: 100,
            };
      const result = await readApi<Record<string, unknown>>(
        await fetch("/api/ozon/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      await loadSnapshot(action === "category_attributes" ? selectedCategoryId : "");
      setNotice(
        action === "ozon_hd_cache_import"
          ? `跟卖缓存导入完成：${String(result.categoriesSynced ?? 0)} 个类目，${String(result.attributesSynced ?? 0)} 个属性，${String(result.valuesSynced ?? 0)} 个字典值。`
          : action === "category_tree"
            ? `类目树同步完成：${String(result.categoriesSynced ?? 0)} 个节点。`
            : `属性同步完成：${String(result.attributesSynced ?? 0)} 个属性，${String(result.valuesSynced ?? 0)} 个字典值。`,
      );
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "同步失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCategoryChange(categoryId: string) {
    setSelectedCategoryId(categoryId);
    setBusyAction("search");
    setError(null);
    try {
      await loadSnapshot(categoryId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取类目失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSearch() {
    setBusyAction("search");
    setError(null);
    try {
      await loadSnapshot("", query);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "搜索失败");
    } finally {
      setBusyAction(null);
    }
  }

  function handleFeatureChange(attributeId: string, value: string) {
    setEditableValues((current) => ({
      ...current,
      [attributeId]: value,
    }));
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-2xl">
                  <TreePine className="h-6 w-6" />
                  Ozon 上架特征映射
                </CardTitle>
                <CardDescription className="mt-2 max-w-3xl leading-6">
                  类目、必填属性和字典值来自本地 Ozon Seller API 同步表；DeepSeek 后续只消费这些同步结果做字段匹配。
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={ready ? "success" : "destructive"}>{ready ? "Ozon 已配置" : "Ozon 未配置"}</Badge>
                <Badge variant="outline">{snapshot.connection.baseUrl}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
	            <OzonApiConfigPanel
	              connection={snapshot.connection}
	              onConnectionChange={handleConnectionChange}
	              onSynced={() => loadSnapshot("", query)}
	            />

            <div className="rounded-lg border border-slate-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">跟卖体系缓存</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {snapshot.localCache.cacheDir
                      ? snapshot.localCache.cacheDir
                      : `未找到 category_tree.json，已检查 ${snapshot.localCache.candidates.length} 个候选路径`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={snapshot.localCache.categoryTreeExists ? "success" : "warning"}>
                    {snapshot.localCache.categoryTreeExists ? "已找到类目树" : "未找到类目树"}
                  </Badge>
                  <Badge variant="outline">{snapshot.localCache.attributeCacheFiles} 个属性缓存</Badge>
                  <Badge variant="outline">{snapshot.localCache.dictionaryCacheFiles} 个字典缓存</Badge>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => runSync("ozon_hd_cache_import")}
                  disabled={!snapshot.localCache.categoryTreeExists || busyAction !== null}
                  className="gap-2"
                >
                  {busyAction === "cache" ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}
                  导入跟卖缓存
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-5">
              <div className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                <p className="text-xs text-slate-500 dark:text-slate-400">类目节点</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">{snapshot.counts.categories}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                <p className="text-xs text-slate-500 dark:text-slate-400">末级类型</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">{snapshot.counts.leafCategories}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                <p className="text-xs text-slate-500 dark:text-slate-400">属性</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">{snapshot.counts.attributes}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                <p className="text-xs text-slate-500 dark:text-slate-400">必填属性</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">{snapshot.counts.requiredAttributes}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                <p className="text-xs text-slate-500 dark:text-slate-400">字典值</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">{snapshot.counts.values}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => runSync("category_tree")} disabled={!ready || busyAction !== null} className="gap-2">
                {busyAction === "tree" ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}
                同步 Ozon 类目树
              </Button>
              <Button
                variant="outline"
                onClick={() => runSync("category_attributes")}
                disabled={!ready || !selectedCategoryId || busyAction !== null}
                className="gap-2"
              >
                {busyAction === "attributes" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                同步当前类目属性
              </Button>
            </div>

            {snapshot.lastSyncRun ? (
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                最近同步：{snapshot.lastSyncRun.action} / {snapshot.lastSyncRun.status} /{" "}
                {new Date(snapshot.lastSyncRun.startedAt).toLocaleString()}
                {snapshot.lastSyncRun.errorMessage ? ` / ${snapshot.lastSyncRun.errorMessage}` : ""}
              </p>
            ) : null}
            {notice ? <p className="text-sm text-emerald-600 dark:text-emerald-300">{notice}</p> : null}
            {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              DeepSeek 映射契约
            </CardTitle>
            <CardDescription>输入改为数据库同步表，输出仍然是可人工复核的 Ozon 属性草稿。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              {sampleSourceModules.map((module) => (
                <div key={module.id} className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">{module.label}</p>
                    <span className={cn("text-xs font-semibold", confidenceColor(module.confidence))}>
                      {Math.round(module.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{module.content}</p>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-6 text-slate-600 dark:border-white/10 dark:bg-black/30 dark:text-slate-300">
              <p>
                输入：<span className="font-semibold">{deepseekMappingContract.input.sourceModules}</span> +{" "}
                <span className="font-semibold">{deepseekMappingContract.input.ozonCategoryTree}</span>
              </p>
              <p>
                输出：<span className="font-semibold">{deepseekMappingContract.output.mappedFeatures}</span>
              </p>
              <ul className="mt-3 space-y-1">
                {deepseekMappingContract.hardRules.map((rule) => (
                  <li key={rule}>- {rule}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card>
          <CardHeader>
            <CardTitle>Ozon 同步表</CardTitle>
            <CardDescription>先选 Ozon 末级类型，再同步该类型的属性和字典值。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已同步类目" />
              <Button variant="outline" onClick={handleSearch} disabled={busyAction !== null} className="gap-2">
                {busyAction === "search" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                搜索
              </Button>
            </div>

            <select
              value={selectedCategoryId}
              onChange={(event) => handleCategoryChange(event.target.value)}
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none dark:border-white/10 dark:bg-black/20 dark:text-white"
            >
              {snapshot.categories.length === 0 ? <option value="">暂无同步类目</option> : null}
              {snapshot.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label} / {category.descriptionCategoryId ?? "-"} / {category.typeId ?? "-"}
                </option>
              ))}
            </select>

            {selectedCategory ? (
              <div className="rounded-lg border border-slate-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900 dark:text-white">{selectedCategory.label}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{selectedCategory.path.join(" / ")}</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      description_category_id: {selectedCategory.descriptionCategoryId ?? "待同步"} / type_id:{" "}
                      {selectedCategory.typeId ?? "待同步"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{selectedCategory.attributeCount ?? 0} 属性</Badge>
                    <Badge variant="destructive">{selectedCategory.requiredAttributeCount ?? 0} 必填</Badge>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                还没有 Ozon 类目数据。优先点击“导入跟卖缓存”；如果本地没有缓存，再配置密钥后点击“同步 Ozon 类目树”。
              </div>
            )}

            <div className="rounded-lg border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">上架基础字段</p>
                <Badge variant="destructive">{baseFlat.filter((item) => item.requirement === "required").length} 必填</Badge>
              </div>
              <ul className="mt-4 space-y-2">
                {ozonListingBaseFields.map((node) => (
                  <AttributeTree key={node.id} node={node} />
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">当前类目真实属性</p>
                <Badge variant="warning">{categoryAttributes.length} 项</Badge>
              </div>
              <div className="mt-4 space-y-4">
                {Object.entries(groupedAttributes).length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">还没有同步该类目的属性。</p>
                ) : null}
                {Object.entries(groupedAttributes).map(([groupName, attributes]) => (
                  <div key={groupName} className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-black/20">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">{groupName}</p>
                      <Badge variant="outline">{attributes.length} 项</Badge>
                    </div>
                    <div className="mt-3 space-y-2">
                      {attributes.map((attribute) => (
                        <div key={attribute.id} className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/[0.04]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium text-slate-900 dark:text-white">{attribute.name}</p>
                            <div className="flex flex-wrap gap-2">
                              {attribute.isRequired ? <Badge variant="destructive">必填</Badge> : <Badge variant="outline">选填</Badge>}
                              {attribute.dictionaryId ? <Badge variant="warning">字典 {attribute.dictionaryValueCount}</Badge> : null}
                              {attribute.type ? <Badge variant="outline">{attribute.type}</Badge> : null}
                            </div>
                          </div>
                          {attribute.description ? (
                            <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{attribute.description}</p>
                          ) : null}
                          {attribute.values.length ? (
                            <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                              字典示例：{attribute.values.slice(0, 8).map((value) => value.value).join(" / ")}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>可上架特征草稿</CardTitle>
                <CardDescription>草稿由真实 Ozon 属性表生成，缺失和字典匹配项会进入人工二次修改。</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="warning">{reviewCount} 项需处理</Badge>
                <Badge variant="outline">{draftFeatures.length} 项草稿</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {draftFeatures.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                同步当前类目属性后，这里会自动列出 Ozon 必填和需要字典匹配的字段。
              </div>
            ) : null}

            {draftFeatures.map((feature) => {
              const editedValue = editableValues[feature.attributeId] ?? feature.value;
              const meta = statusMeta[feature.status === "missing" && editedValue.trim() ? "review" : feature.status];
              return (
                <div key={feature.attributeId} className="rounded-lg border border-slate-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-white">{feature.label}</p>
                      <p className="mt-1 text-xs text-slate-400">Ozon attribute id：{feature.attributeId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn("text-xs font-semibold", confidenceColor(feature.confidence))}>
                        {Math.round(feature.confidence * 100)}%
                      </span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </div>
                  </div>

                  <Textarea
                    value={editedValue}
                    onChange={(event) => handleFeatureChange(feature.attributeId, event.target.value)}
                    className="mt-3 min-h-[78px] rounded-lg"
                    placeholder="等待 DeepSeek 自动匹配，或先手动填写"
                  />

                  <div className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500 dark:bg-white/[0.04] dark:text-slate-400">
                    {feature.status === "auto" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    ) : feature.status === "missing" ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                    ) : (
                      <PencilLine className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    )}
                    <span>{feature.reason}</span>
                  </div>
                </div>
              );
            })}

            <div className="rounded-lg border border-slate-200 bg-slate-950 p-4 text-white dark:border-white/10">
              <div className="flex items-center gap-2">
                <FileJson2 className="h-4 w-4" />
                <p className="text-sm font-semibold">导出结构预览</p>
              </div>
              <pre className="mt-3 overflow-auto rounded-lg bg-black/40 p-4 text-xs leading-6 text-slate-200">
                {JSON.stringify(
                  {
                    category: selectedCategory
                      ? {
                          recordId: selectedCategory.id,
                          descriptionCategoryId: selectedCategory.descriptionCategoryId,
                          typeId: selectedCategory.typeId,
                          path: selectedCategory.path,
                        }
                      : null,
                    listingBaseFields: baseFlat.map((field) => field.ozonCode ?? field.id),
                    mapped: draftFeatures.map(({ attributeId, label, status, confidence }) => ({
                      attributeId,
                      label,
                      value: editableValues[attributeId] ?? "",
                      status: status === "missing" && (editableValues[attributeId] ?? "").trim() ? "review" : status,
                      confidence,
                    })),
                  },
                  null,
                  2,
                )}
              </pre>
            </div>

            <Button variant="outline" className="w-full gap-2" disabled>
              <Sparkles className="h-4 w-4" />
              DeepSeek 自动映射将在下一步接入
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
