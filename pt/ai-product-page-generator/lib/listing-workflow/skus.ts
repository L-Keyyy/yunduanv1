export type ProductSkuOption = {
  id: string;
  title: string;
  price: string;
  stock: number | null;
  specText: string;
  specs: Record<string, string>;
  images: string[];
  raw: Record<string, unknown>;
  source: "1688" | "ai";
};

export type ProductSkuSelection = {
  mode: "single" | "multiple" | "all";
  selectedSkuId: string;
  selectedSkuIds: string[];
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalar(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function imageUrl(value: unknown) {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  return scalar(
    record.src ?? record.url ?? record.imageUrl ?? record.imgUrl,
  );
}

function uniqueImageUrls(values: unknown[]) {
  const urls = new Set<string>();
  for (const value of values) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const url = imageUrl(candidate);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

export function extractProductSkuOptions(
  data: Record<string, unknown> | null,
): ProductSkuOption[] {
  if (!data) return [];
  return asArray(data.variants).flatMap((entry, index) => {
    const variant = asRecord(entry);
    if (!Object.keys(variant).length) return [];
    const characteristics = asArray(variant.characteristics)
      .map(asRecord)
      .flatMap((item) => {
        const name = scalar(item.name ?? item.key ?? item.label);
        const value = scalar(
          item.valueText ?? item.value ?? asArray(item.values)[0],
        );
        return name && value ? [[name, value] as const] : [];
      });
    const explicitSpecs = Object.entries(asRecord(variant.specs)).flatMap(
      ([key, value]) => {
        const text = scalar(value);
        return text ? [[key, text] as const] : [];
      },
    );
    const specs = Object.fromEntries([...characteristics, ...explicitSpecs]);
    const specText =
      scalar(variant.specText ?? variant.spec_attrs ?? variant.specAttrs) ||
      Object.entries(specs)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" / ");
    const id =
      scalar(
        variant.skuId ??
          variant.sku_id ??
          variant.productId ??
          variant.product_id ??
          variant.id,
      ) || `sku-${index + 1}`;
    const stockText = scalar(
      variant.stock ?? variant.canBookCount ?? variant.quantity,
    );
    const stockNumber = Number(stockText);
    return [
      {
        id,
        title:
          scalar(variant.title ?? variant.name) ||
          specText ||
          `规格 ${index + 1}`,
        price: scalar(
          variant.price ?? variant.discountPrice ?? variant.retailPrice,
        ),
        stock: Number.isFinite(stockNumber) ? stockNumber : null,
        specText: specText || `规格 ${index + 1}`,
        specs,
        images: uniqueImageUrls([
          variant.images,
          variant.image,
          variant.imageUrl,
          asRecord(variant.gallery).images,
        ]),
        raw: variant,
        source: "1688" as const,
      },
    ];
  });
}

export function readProductSkuSelection(
  data: Record<string, unknown>,
): ProductSkuSelection {
  const options = extractProductSkuOptions(data);
  const stored = asRecord(data.skuSelection);
  const mode =
    stored.mode === "all"
      ? "all"
      : stored.mode === "multiple"
        ? "multiple"
        : "single";
  const storedSelectedIds = Array.isArray(stored.selectedSkuIds)
    ? stored.selectedSkuIds.map(String)
    : [];
  const selectedSkuId =
    storedSelectedIds.find((id) => options.some((option) => option.id === id)) ??
    options[0]?.id ??
    "";
  const selectedSkuIds =
    mode === "all"
      ? options.map((option) => option.id)
      : mode === "multiple"
        ? storedSelectedIds.filter((id) => options.some((option) => option.id === id))
        : selectedSkuId
          ? [selectedSkuId]
          : [];
  return { mode, selectedSkuId, selectedSkuIds };
}

export function applySkuSelectionToJson(
  data: Record<string, unknown>,
  mode: "single" | "multiple" | "all",
  selectedSkuId: string,
  selectedSkuIds: string[] = [],
) {
  const options = extractProductSkuOptions(data);
  const requestedIds = new Set(selectedSkuIds);
  const selected =
    mode === "all"
      ? options
      : mode === "multiple"
        ? options.filter((option) => requestedIds.has(option.id))
        : options.filter((option) => option.id === selectedSkuId).slice(0, 1);
  return {
    ...data,
    // 保留全部原始 SKU，后续仍可重新选择；AI 通过 skuSelection 读取本次范围。
    variants: Array.isArray(data.variants)
      ? data.variants
      : options.map((option) => option.raw),
    skuSelection: {
      mode,
      selectedSkuIds: selected.map((option) => option.id),
      selectedCount: selected.length,
      totalCount: options.length,
    },
    ...(mode === "single" && selected[0]
      ? {
          selectedVariant: selected[0].raw,
          ...(selected[0].price ? { price: selected[0].price } : {}),
        }
      : { selectedVariant: null }),
  };
}
