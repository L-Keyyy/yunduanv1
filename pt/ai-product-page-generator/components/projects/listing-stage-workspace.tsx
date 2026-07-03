"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Images,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ListingWorkflowFeature,
  ListingWorkflowItem,
  ListingWorkflowStage,
} from "@/lib/listing-workflow/items";
import { listingItemStatusLabel } from "@/lib/listing-workflow/items";
import { normalizeOzonAttributeMatchKey } from "@/lib/ozon/attribute-match";
import type { OzonFeatureSnapshot } from "@/lib/ozon/snapshot";
import type { ApiResponseShape } from "@/lib/utils/api";

async function readApi<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as ApiResponseShape<T>;
  if (!response.ok || !payload.success || payload.data === null) {
    throw new Error(
      !payload.success
        ? payload.error?.message || "请求失败"
        : `请求失败：${response.status}`,
    );
  }
  return payload.data as T;
}

function normalizeItem(raw: ListingWorkflowItem): ListingWorkflowItem {
  return {
    ...raw,
    categoryPath: Array.isArray(raw.categoryPath) ? raw.categoryPath : null,
    scrapedData:
      raw.scrapedData && typeof raw.scrapedData === "object"
        ? raw.scrapedData
        : {},
    features: Array.isArray(raw.features) ? raw.features : null,
    notes: Array.isArray(raw.notes) ? raw.notes : null,
  };
}

function baseFeatureId(feature: ListingWorkflowFeature) {
  return feature.attributeId.replace(/^base:/, "");
}

function syncBaseFeatures(
  features: ListingWorkflowFeature[] | null,
  draft: ListingWorkflowItem,
): ListingWorkflowFeature[] | null {
  if (!features) return null;
  const baseValues: Record<string, string> = {
    name: draft.title,
    offer_id: draft.offerId,
    price: draft.currentPrice ?? "",
    old_price: draft.oldPrice ?? "",
    min_price: draft.minPrice ?? "",
    cost_price: draft.costPrice ?? "",
    currency_code: draft.currency,
    images: draft.imageUrl ?? "",
  };
  return features.map((feature) => {
    if (feature.group !== "base") return feature;
    const value = baseValues[baseFeatureId(feature)];
    return value === undefined
      ? feature
      : {
          ...feature,
          value,
          source: "人工修改",
          status: value
            ? ("review" as const)
            : feature.required
              ? ("missing" as const)
              : ("review" as const),
        };
  });
}

async function resolveOzonAttributeValues(
  features: ListingWorkflowFeature[] | null,
  categoryId: string | null,
) {
  if (!features || !categoryId) return features;
  const snapshot = await readApi<OzonFeatureSnapshot>(
    await fetch(`/api/ozon/features?categoryId=${categoryId}`, {
      cache: "no-store",
    }),
  );
  const attributeById = new Map(
    (snapshot.selectedCategory?.attributes ?? []).map((attribute) => [
      attribute.ozonAttributeId,
      attribute,
    ]),
  );
  return features.map((feature) => {
    if (feature.group !== "category" || !feature.value.trim()) return feature;
    const attribute = attributeById.get(
      feature.ozonCode || feature.attributeId,
    );
    if (!attribute) return feature;
    if (!attribute.dictionaryId) {
      return {
        ...feature,
        ozonAttributeValues: [{ value: feature.value.trim() }],
      };
    }
    const matchedValue = attribute.values.find(
      (candidate) =>
        normalizeOzonAttributeMatchKey(candidate.value) ===
        normalizeOzonAttributeMatchKey(feature.value),
    );
    const dictionaryValueId = Number(matchedValue?.ozonValueId);
    return Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
      ? {
          ...feature,
          ozonAttributeValues: [
            {
              dictionary_value_id: dictionaryValueId,
              value: feature.value.trim(),
            },
          ],
        }
      : {
          ...feature,
          ozonAttributeValues: undefined,
          status: "review",
          reason:
            "人工修改的值没有匹配到当前 Ozon 字典，需要在主工作台继续核对。",
        };
  });
}

function statusVariant(item: ListingWorkflowItem) {
  if (item.status === "MATCHED") return "success" as const;
  if (item.status === "AI_FAILED") return "destructive" as const;
  if (item.status === "AI_RUNNING") return "warning" as const;
  return "outline" as const;
}

function imageProxyUrl(rawUrl: string | null) {
  if (!rawUrl) return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("blob:")
  ) {
    return normalized;
  }
  return `/api/image-proxy?url=${encodeURIComponent(normalized)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeImageCandidate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (
    !normalized.startsWith("http://") &&
    !normalized.startsWith("https://") &&
    !normalized.startsWith("/")
  ) {
    return null;
  }
  if (
    !/\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(normalized) &&
    !/alicdn\.com\/img\//i.test(normalized)
  ) {
    return null;
  }
  return normalized.replace(
    /\.(?:search|summ|\d+x\d+)(?=\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$)/i,
    "",
  );
}

function appendImageValues(
  value: unknown,
  output: string[],
  depth = 0,
) {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const normalized = normalizeImageCandidate(value);
    if (normalized) output.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => appendImageValues(entry, output, depth + 1));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  [
    "src",
    "url",
    "image",
    "imageUrl",
    "coverImage",
    "primary_image",
    "primaryImage",
    "images",
    "imageUrls",
    "pictures",
  ].forEach((key) => appendImageValues(record[key], output, depth + 1));
}

function itemImageUrls(item: ListingWorkflowItem) {
  const candidates: string[] = [];
  appendImageValues(item.imageUrl, candidates);

  const scraped = item.scrapedData;
  appendImageValues(scraped.gallery, candidates);
  appendImageValues(asRecord(scraped.description)?.images, candidates);
  appendImageValues(scraped.images, candidates);
  appendImageValues(scraped.imageUrls, candidates);
  appendImageValues(scraped.selectedVariant, candidates);
  appendImageValues(scraped.variants, candidates);

  const imageFeature = item.features?.find(
    (feature) =>
      feature.attributeId === "base:images" ||
      feature.ozonCode === "primary_image/images",
  );
  if (imageFeature?.value.trim()) {
    try {
      appendImageValues(JSON.parse(imageFeature.value), candidates);
    } catch {
      appendImageValues(imageFeature.value, candidates);
    }
  }

  return [...new Set(candidates)];
}

function RemoteProductImage({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  className: string;
}) {
  const source = imageProxyUrl(url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  return source && !failed ? (
    <img
      src={source}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  ) : (
    <div
      className={`flex items-center justify-center bg-slate-50 text-slate-300 dark:bg-black/30 ${className}`}
    >
      <Box className="h-7 w-7" />
    </div>
  );
}

function ProductImage({ item }: { item: ListingWorkflowItem }) {
  return (
    <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-black/30">
      {item.imageUrl ? (
        <RemoteProductImage
          url={item.imageUrl}
          alt={item.title}
          className="h-full w-full object-cover"
        />
      ) : (
        <Box className="h-7 w-7 text-slate-300" />
      )}
    </div>
  );
}

function EmbeddedProductGallery({ item }: { item: ListingWorkflowItem }) {
  const images = useMemo(() => itemImageUrls(item), [
    item.imageUrl,
    item.scrapedData,
    item.features,
  ]);
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedImage = images[selectedIndex] ?? images[0] ?? "";

  useEffect(() => {
    setSelectedIndex(0);
    setExpanded(false);
  }, [item.id]);

  return (
    <section
      data-testid="product-image-gallery"
      className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-black/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Images className="h-5 w-5 text-slate-700 dark:text-slate-200" />
          <h3 className="text-base font-semibold text-slate-950 dark:text-white">
            商品图片
          </h3>
          <Badge variant="outline">{images.length} 张</Badge>
        </div>
        {images.length > 1 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? (
              <ChevronUp className="mr-1.5 h-4 w-4" />
            ) : (
              <ChevronDown className="mr-1.5 h-4 w-4" />
            )}
            {expanded ? "收起全部图片" : `查看全部 ${images.length} 张`}
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {selectedImage ? (
          <button
            type="button"
            className="group relative block h-64 w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 text-left dark:border-white/10 dark:bg-black/30 sm:h-72"
            aria-label={
              expanded
                ? "收起全部商品图片"
                : `查看全部 ${images.length} 张商品图片`
            }
            onClick={() =>
              images.length > 1 && setExpanded((current) => !current)
            }
          >
            <RemoteProductImage
              url={selectedImage}
              alt={`${item.title} 商品图 ${selectedIndex + 1}`}
              className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
            />
            {images.length > 1 ? (
              <span className="absolute bottom-3 right-3 rounded-full bg-slate-950/80 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                {expanded ? "点击收起" : `点击查看全部 · ${images.length} 张`}
              </span>
            ) : null}
          </button>
        ) : (
          <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 text-sm text-slate-400 dark:border-white/10 sm:h-72">
            暂无商品图片
          </div>
        )}

        {expanded ? (
          <div className="grid min-w-0 grid-cols-2 content-start gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {images.map((image, index) => (
              <button
                type="button"
                key={image}
                aria-label={`查看第 ${index + 1} 张商品图片`}
                onClick={() => setSelectedIndex(index)}
                className={`relative aspect-square min-w-0 overflow-hidden rounded-xl border-2 bg-slate-50 transition dark:bg-black/30 ${
                  index === selectedIndex
                    ? "border-slate-950 ring-2 ring-slate-950/10 dark:border-white"
                    : "border-transparent hover:border-slate-300 dark:hover:border-white/30"
                }`}
              >
                <RemoteProductImage
                  url={image}
                  alt={`${item.title} 商品图 ${index + 1}`}
                  className="h-full w-full object-cover"
                />
                <span className="absolute left-2 top-2 rounded-full bg-slate-950/70 px-2 py-0.5 text-[10px] font-medium text-white">
                  {index + 1}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            className="flex min-h-40 min-w-0 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 px-6 text-center transition hover:border-slate-400 hover:bg-slate-50 dark:border-white/10 dark:hover:border-white/20 dark:hover:bg-white/[0.03]"
            onClick={() => images.length > 1 && setExpanded(true)}
            disabled={images.length < 2}
          >
            <Images className="h-8 w-8 text-slate-300" />
            <span className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              {images.length > 1
                ? `已采集 ${images.length} 张商品图片`
                : "当前只有 1 张商品图片"}
            </span>
            {images.length > 1 ? (
              <span className="mt-1 text-xs text-slate-400">
                点击这里或左侧主图展开全部照片
              </span>
            ) : null}
          </button>
        )}
      </div>
    </section>
  );
}

type EditablePriceField = "currentPrice" | "oldPrice" | "minPrice";

const editablePriceLabels: Record<EditablePriceField, string> = {
  currentPrice: "当前价格",
  oldPrice: "折扣前价格",
  minPrice: "最低价格",
};

function isDescriptionFeature(feature: ListingWorkflowFeature) {
  return (
    feature.valueType?.toLowerCase().includes("rich") ||
    feature.valueType?.toLowerCase().includes("multiline") ||
    /描述|说明|简介|description|описан/i.test(
      `${feature.label} ${feature.ozonCode ?? ""}`,
    )
  );
}

function InlinePriceInput({
  item,
  field,
  onSaved,
}: {
  item: ListingWorkflowItem;
  field: EditablePriceField;
  onSaved: (item: ListingWorkflowItem) => void;
}) {
  const savedValue = item[field] ?? "";
  const [value, setValue] = useState(savedValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(savedValue);
  }, [item.id, savedValue]);

  async function save() {
    const nextValue = value.trim();
    if (nextValue === savedValue) return;
    setSaving(true);
    try {
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              [field]: nextValue || null,
            }),
          }),
        ),
      );
      onSaved(saved);
      toast.success(`${editablePriceLabels[field]}已保存`);
    } catch (error) {
      setValue(savedValue);
      toast.error(error instanceof Error ? error.message : "价格保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative min-w-24">
      <Input
        value={value}
        inputMode="decimal"
        aria-label={`${item.offerId} ${editablePriceLabels[field]}`}
        placeholder="填写"
        className="h-10 bg-white pr-8 text-sm dark:bg-black/20"
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setValue(savedValue);
            event.currentTarget.blur();
          }
        }}
      />
      {saving ? (
        <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
      ) : null}
    </div>
  );
}

function FullscreenItemEditor({
  item,
  onClose,
  onSaved,
}: {
  item: ListingWorkflowItem;
  onClose: () => void;
  onSaved: (item: ListingWorkflowItem) => void;
}) {
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const features = draft.features ?? [];
  const categoryFeatures = features.filter(
    (feature) => feature.group !== "base",
  );
  const descriptionFeature = features.find(
    (feature) =>
      feature.group === "base" &&
      (feature.attributeId === "base:short_description" ||
        feature.ozonCode === "description"),
  );

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  function updateFeature(attributeId: string, value: string) {
    setDraft((current) => ({
      ...current,
      features:
        current.features?.map((feature) =>
          feature.attributeId === attributeId
            ? {
                ...feature,
                value,
                source: "人工修改",
                status: value
                  ? "review"
                  : feature.required
                    ? "missing"
                    : "review",
                ozonAttributeValues: undefined,
              }
            : feature,
        ) ?? null,
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const baseSyncedFeatures = syncBaseFeatures(draft.features, draft);
      const syncedFeatures = await resolveOzonAttributeValues(
        baseSyncedFeatures,
        draft.categoryId,
      );
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${draft.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: draft.title,
              offerId: draft.offerId,
              imageUrl: draft.imageUrl,
              currentPrice: draft.currentPrice,
              oldPrice: draft.oldPrice,
              minPrice: draft.minPrice,
              costPrice: draft.costPrice,
              currency: draft.currency,
              features: syncedFeatures,
            }),
          }),
        ),
      );
      toast.success("商品字段已保存");
      onSaved(saved);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "商品保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] h-[100dvh] w-screen overflow-y-auto bg-slate-100 dark:bg-[#09090a]">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#111214]/95">
        <div className="flex w-full flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {draft.stage === "PROCESSING" ? "加工阶段" : "采集阶段"}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-white">
              编辑商品卡
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              保存修改
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="关闭全屏编辑"
              onClick={onClose}
              disabled={saving}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="grid min-h-[calc(100dvh-81px)] w-full gap-5 p-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:p-6">
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-28 lg:self-start">
          <div>
            <p className="break-words text-sm font-semibold leading-6 text-slate-950 dark:text-white">
              {draft.title}
            </p>
            <p className="mt-1 break-all text-xs text-slate-500">
              {draft.offerId}
            </p>
          </div>
          <Badge variant={statusVariant(draft)}>
            {listingItemStatusLabel(draft.status)}
          </Badge>
          {draft.categoryLabel ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-black/20">
              <p className="font-medium text-slate-950 dark:text-white">
                {draft.categoryLabel}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {(draft.categoryPath ?? []).join(" / ")}
              </p>
            </div>
          ) : null}
        </aside>

        <div className="min-w-0 space-y-5">
          <EmbeddedProductGallery item={draft} />

          <section className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-black/20">
            <h3 className="text-base font-semibold text-slate-950 dark:text-white">
              商品卡信息
            </h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["title", "商品名称"],
                ["offerId", "货号"],
                ["currentPrice", "当前价格"],
                ["oldPrice", "折扣前价格"],
                ["minPrice", "最低价格"],
                ["costPrice", "成本"],
                ["currency", "币种"],
                ["imageUrl", "商品图片 URL"],
              ].map(([key, label]) => (
                <label key={key} className="min-w-0 space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">
                    {label}
                  </span>
                  <Input
                    className="h-9 min-w-0 text-sm"
                    value={String(
                      draft[key as keyof ListingWorkflowItem] ?? "",
                    )}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            {descriptionFeature ? (
              <label className="mt-4 block min-w-0 space-y-1.5">
                <span className="text-xs font-medium text-slate-500">
                  商品描述
                </span>
                <Textarea
                  value={descriptionFeature.value}
                  className="min-h-32 resize-y text-sm leading-6"
                  onChange={(event) =>
                    updateFeature(
                      descriptionFeature.attributeId,
                      event.target.value,
                    )
                  }
                />
              </label>
            ) : null}
          </section>

          {draft.stage === "PROCESSING" ? (
            <section className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-black/20">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-950 dark:text-white">
                    AI 类目特征
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    AI 匹配类目后字段会自动出现在这里，修改 value
                    会保存到后续 Ozon 上架草稿。
                  </p>
                </div>
                <Badge variant="outline">
                  {categoryFeatures.length} 个字段
                </Badge>
              </div>

              {categoryFeatures.length ? (
                <div className="mt-4 grid min-w-0 gap-3 xl:grid-cols-2">
                  {categoryFeatures.map((feature) => (
                    <label
                      key={feature.attributeId}
                      className={`min-w-0 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/[0.03] ${
                        isDescriptionFeature(feature) ? "xl:col-span-2" : ""
                      }`}
                    >
                      <div
                        className={`grid min-w-0 gap-3 ${
                          isDescriptionFeature(feature)
                            ? "md:grid-cols-[220px_minmax(0,1fr)] md:items-start"
                            : "md:grid-cols-[minmax(120px,180px)_minmax(0,1fr)] md:items-center"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium leading-5 text-slate-900 dark:text-white">
                            {feature.label}
                            {feature.required ? (
                              <span className="ml-1 text-rose-500">*</span>
                            ) : null}
                          </p>
                          <p className="mt-1 break-all text-[11px] text-slate-400">
                            {feature.ozonCode || feature.attributeId}
                            {feature.source ? ` · ${feature.source}` : ""}
                          </p>
                        </div>
                        {isDescriptionFeature(feature) ? (
                          <Textarea
                            value={feature.value}
                            className="min-h-28 min-w-0 resize-y text-sm leading-6"
                            onChange={(event) =>
                              updateFeature(
                                feature.attributeId,
                                event.target.value,
                              )
                            }
                          />
                        ) : (
                          <Input
                            value={feature.value}
                            className="h-9 min-w-0 text-sm"
                            list={
                              feature.options.length
                                ? `stage-options-${feature.attributeId}`
                                : undefined
                            }
                            onChange={(event) =>
                              updateFeature(
                                feature.attributeId,
                                event.target.value,
                              )
                            }
                          />
                        )}
                        {feature.options.length ? (
                          <datalist id={`stage-options-${feature.attributeId}`}>
                            {feature.options.map((option) => (
                              <option key={option} value={option} />
                            ))}
                          </datalist>
                        ) : null}
                      </div>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-dashed border-slate-300 px-5 py-12 text-center text-sm text-slate-500 dark:border-white/10">
                  尚未完成 AI 类目匹配。可回到主页面执行匹配。
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ListingStageWorkspace({
  stage,
}: {
  stage: ListingWorkflowStage;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ListingWorkflowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editingItem, setEditingItem] =
    useState<ListingWorkflowItem | null>(null);
  const [deletingItem, setDeletingItem] =
    useState<ListingWorkflowItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      [item.title, item.offerId, item.categoryLabel ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [items, query]);

  async function loadItems() {
    setLoading(true);
    try {
      const result = await readApi<ListingWorkflowItem[]>(
        await fetch(`/api/listing-workflow/items?stage=${stage}`, {
          cache: "no-store",
        }),
      );
      setItems(result.map(normalizeItem));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "商品列表读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadItems();
  }, [stage]);

  async function moveToProcessing(item: ListingWorkflowItem) {
    setBusyId(item.id);
    try {
      await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: "PROCESSING",
            status: item.status === "MATCHED" ? "MATCHED" : "PENDING_AI",
          }),
        }),
      );
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      toast.success("商品已加入加工阶段");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加入加工阶段失败");
    } finally {
      setBusyId(null);
    }
  }

  async function removeItem() {
    if (!deletingItem) return;
    setBusyId(deletingItem.id);
    try {
      await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${deletingItem.id}`, {
          method: "DELETE",
        }),
      );
      setItems((current) =>
        current.filter((entry) => entry.id !== deletingItem.id),
      );
      toast.success("商品记录已删除");
      setDeletingItem(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索商品名称、货号或类目"
              className="pl-9"
            />
          </div>
          <Button variant="outline" onClick={() => void loadItems()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-black/20">
          {loading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取商品队列
            </div>
          ) : filteredItems.length ? (
            <div className="overflow-x-auto">
              <table className="min-w-[1220px] table-fixed text-left">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500 dark:bg-white/5">
                  <tr>
                    <th className="w-28 px-4 py-4">商品图片</th>
                    <th className="w-64 px-4 py-4">商品名称</th>
                    <th className="w-52 px-4 py-4">货号</th>
                    <th className="w-28 px-4 py-4">当前价格</th>
                    <th className="w-28 px-4 py-4">折扣前价格</th>
                    <th className="w-28 px-4 py-4">最低价格</th>
                    <th className="w-28 px-4 py-4">成本</th>
                    <th
                      className={
                        stage === "PROCESSING"
                          ? "w-56 px-4 py-4"
                          : "w-[420px] px-4 py-4"
                      }
                    >
                      {stage === "PROCESSING" ? "加工状态 / 类目" : "操作"}
                    </th>
                    {stage === "PROCESSING" ? (
                      <th className="w-72 px-4 py-4">操作</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-slate-200 align-middle dark:border-white/10"
                    >
                      <td className="px-4 py-4">
                        <ProductImage item={item} />
                      </td>
                      <td className="px-4 py-4">
                        <p className="line-clamp-2 text-sm font-medium text-slate-950 dark:text-white">
                          {item.title}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.sourcePlatform || "未知来源"}
                        </p>
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-700 dark:text-slate-200">
                        <span className="break-all">{item.offerId}</span>
                      </td>
                      <td className="px-3 py-4 text-sm">
                        <InlinePriceInput
                          item={item}
                          field="currentPrice"
                          onSaved={(saved) =>
                            setItems((current) =>
                              current.map((entry) =>
                                entry.id === saved.id ? saved : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-4 text-sm">
                        <InlinePriceInput
                          item={item}
                          field="oldPrice"
                          onSaved={(saved) =>
                            setItems((current) =>
                              current.map((entry) =>
                                entry.id === saved.id ? saved : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-4 text-sm">
                        <InlinePriceInput
                          item={item}
                          field="minPrice"
                          onSaved={(saved) =>
                            setItems((current) =>
                              current.map((entry) =>
                                entry.id === saved.id ? saved : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-4 py-4 text-sm font-medium text-amber-700 dark:text-amber-300">
                        {item.costPrice || "-"}
                      </td>
                      <td className="px-4 py-4">
                        {stage === "PROCESSING" ? (
                          <div className="space-y-2">
                            <Badge variant={statusVariant(item)}>
                              {listingItemStatusLabel(item.status)}
                            </Badge>
                            <p className="line-clamp-2 text-xs text-slate-500">
                              {item.categoryLabel || "等待类目匹配"}
                            </p>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => void moveToProcessing(item)}
                              disabled={busyId === item.id}
                            >
                              <ArrowRight className="mr-1.5 h-4 w-4" />
                              加入加工阶段
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingItem(item)}
                            >
                              <Pencil className="mr-1.5 h-4 w-4" />
                              编辑商品卡
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingItem(item)}
                            >
                              <Trash2 className="mr-1.5 h-4 w-4" />
                              删除
                            </Button>
                          </div>
                        )}
                      </td>
                      {stage === "PROCESSING" ? (
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-2">
                            {item.status !== "MATCHED" ? (
                              <Button
                                size="sm"
                                onClick={() =>
                                  router.push(`/projects/new?item=${item.id}`)
                                }
                              >
                                <ArrowRight className="mr-1.5 h-4 w-4" />
                                去 AI 匹配
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingItem(item)}
                            >
                              <Pencil className="mr-1.5 h-4 w-4" />
                              编辑商品卡
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingItem(item)}
                            >
                              <Trash2 className="mr-1.5 h-4 w-4" />
                              删除
                            </Button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <Box className="h-10 w-10 text-slate-300" />
              <p className="mt-4 text-sm font-medium text-slate-800 dark:text-slate-100">
                {stage === "COLLECTED"
                  ? "还没有采集商品"
                  : "还没有进入加工阶段的商品"}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {stage === "COLLECTED"
                  ? "回到主页面输入 1688 链接并启动采集。"
                  : "在采集阶段点击“加入加工阶段”。"}
              </p>
            </div>
          )}
        </div>
      </div>

      {editingItem ? (
        <FullscreenItemEditor
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={(saved) =>
            setItems((current) =>
              current.map((entry) => (entry.id === saved.id ? saved : entry)),
            )
          }
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deletingItem)}
        title="删除商品记录？"
        description="这会同时删除该商品保存的采集 JSON 和 AI 特征草稿，操作不可恢复。"
        confirmText="删除"
        destructive
        loading={Boolean(deletingItem && busyId === deletingItem.id)}
        onConfirm={() => void removeItem()}
        onCancel={() => setDeletingItem(null)}
        icon={<Trash2 className="h-5 w-5" />}
      />
    </>
  );
}
