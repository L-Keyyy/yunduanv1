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

export type OzonPackageMetrics = {
  depth: number;
  width: number;
  height: number;
  weight: number;
  dimensionUnit: "mm";
  weightUnit: "g";
};

type PackageFeature = {
  attributeId: string;
  ozonCode?: string | null;
  value?: string;
  aiJsonValue?: string;
  ozonAttributeValues?: Array<{ value?: string }>;
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

function packageNumber(value: unknown) {
  const matched = String(value ?? "").match(/\d+(?:[.,]\d+)?/);
  if (!matched) return null;
  const parsed = Number(matched[0].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function packageDimensionMm(value: unknown, unitValue: unknown) {
  const amount = packageNumber(value);
  if (!amount) return null;
  const unit = `${String(unitValue ?? "")} ${String(value ?? "")}`
    .toLowerCase()
    .replace(/\s+/g, "");
  const multiplier = /cm|厘米|公分/.test(unit)
    ? 10
    : /(?:^|[^m])m(?:$|[^m])|米/.test(unit)
      ? 1000
      : /in|inch|英寸/.test(unit)
        ? 25.4
        : 1;
  return Math.max(1, Math.round(amount * multiplier));
}

function packageWeightG(value: unknown, unitValue: unknown) {
  const amount = packageNumber(value);
  if (!amount) return null;
  const unit = `${String(unitValue ?? "")} ${String(value ?? "")}`
    .toLowerCase()
    .replace(/\s+/g, "");
  const multiplier = /kg|公斤|千克/.test(unit)
    ? 1000
    : /lb|磅/.test(unit)
      ? 453.59237
      : 1;
  return Math.max(1, Math.round(amount * multiplier));
}

function combinedPackageDimensionsMm(...sources: Record<string, unknown>[]) {
  for (const source of sources) {
    for (const entry of asArray(source.characteristics)) {
      const characteristic = asRecord(entry);
      const name = scalar(characteristic.name ?? characteristic.key ?? characteristic.label);
      const value = scalar(
        characteristic.valueText ??
          characteristic.value ??
          asArray(characteristic.values)[0],
      );
      if (!/(?:包装|包裹|package|shipping)/i.test(`${name} ${value}`)) continue;
      if (!/(?:外形|尺寸|规格|size|dimension)/i.test(name)) continue;
      const match = value.match(
        /(\d+(?:[.,]\d+)?)\s*[xх×*＊]\s*(\d+(?:[.,]\d+)?)\s*[xх×*＊]\s*(\d+(?:[.,]\d+)?)/i,
      );
      if (!match) continue;
      const unit = value.match(/(?:mm|cm|in(?:ch)?|[毫厘公英]米|公分|英寸)/i)?.[0] ?? name;
      const dimensions = match.slice(1, 4).map((part) => packageDimensionMm(part, unit));
      if (dimensions.every((part): part is number => Boolean(part))) {
        return { depth: dimensions[0], width: dimensions[1], height: dimensions[2] };
      }
    }
  }
  return null;
}

function featurePackageNumber(
  features: PackageFeature[] | undefined,
  attributeIds: string[],
) {
  const feature = features?.find((entry) =>
    attributeIds.includes(
      String(entry.ozonCode || entry.attributeId).replace(/^base:/, ""),
    ),
  );
  if (!feature) return null;
  return packageNumber(
    feature.ozonAttributeValues?.[0]?.value ??
      feature.aiJsonValue ??
      feature.value,
  );
}

export function deriveOzonPackageMetrics(
  raw: Record<string, unknown>,
  features?: PackageFeature[],
  productRaw: Record<string, unknown> = {},
): OzonPackageMetrics | null {
  const packageInfo = {
    ...asRecord(
      productRaw.packageInfo ?? productRaw.packaging ?? productRaw.package,
    ),
    ...asRecord(
    raw.packageInfo ?? raw.packaging ?? raw.package,
    ),
  };
  const dimensionUnit =
    packageInfo.dimensionUnit ?? packageInfo.sizeUnit ?? packageInfo.unit;
  const weightUnit = packageInfo.weightUnit ?? packageInfo.unit;
  const weight =
    packageWeightG(
      packageInfo.weightG ??
        packageInfo.weight ??
        packageInfo.value ??
        packageInfo.weightKg,
      packageInfo.weightG !== undefined
        ? "g"
        : packageInfo.weightKg !== undefined
          ? "kg"
          : weightUnit,
    ) ?? featurePackageNumber(features, ["4497", "4383"]);
  if (!weight) return null;

  let depth = packageDimensionMm(
    packageInfo.depthMm ?? packageInfo.depth ?? packageInfo.length,
    packageInfo.depthMm !== undefined ? "mm" : dimensionUnit,
  );
  let width = packageDimensionMm(
    packageInfo.widthMm ?? packageInfo.width,
    packageInfo.widthMm !== undefined ? "mm" : dimensionUnit,
  );
  let height = packageDimensionMm(
    packageInfo.heightMm ?? packageInfo.height,
    packageInfo.heightMm !== undefined ? "mm" : dimensionUnit,
  );
  const combined = combinedPackageDimensionsMm(raw, productRaw);
  depth ??= combined?.depth ?? null;
  width ??= combined?.width ?? null;
  height ??= combined?.height ?? null;
  if ((!depth || !width || !height) && weight < 500) {
    depth ??= 100;
    width ??= 50;
    height ??= 10;
  }
  if (!depth || !width || !height) return null;
  depth = Math.max(depth, 100);
  width = Math.max(width, 50);
  height = Math.max(height, 10);
  return {
    depth,
    width,
    height,
    weight,
    dimensionUnit: "mm",
    weightUnit: "g",
  };
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
      : stored.mode === "single"
        ? "single"
        : "multiple";
  const storedSelectedIds = Array.isArray(stored.selectedSkuIds)
    ? stored.selectedSkuIds.map(String)
    : [];
  const storedSelectedSkuId = storedSelectedIds.find((id) =>
    options.some((option) => option.id === id),
  );
  const selectedSkuId =
    storedSelectedSkuId ??
    (mode === "single" || mode === "all" ? options[0]?.id ?? "" : "");
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

export function applyOzonPackageMetricsToSelectedSkus(
  data: Record<string, unknown>,
  metrics: OzonPackageMetrics,
  selectedIds = readProductSkuSelection(data).selectedSkuIds,
) {
  const selectedSkuIds = new Set(selectedIds);
  const packageInfo = {
    depthMm: metrics.depth,
    widthMm: metrics.width,
    heightMm: metrics.height,
    weightG: metrics.weight,
    dimensionUnit: metrics.dimensionUnit,
    weightUnit: metrics.weightUnit,
    source: "人工修改",
  };
  return {
    ...data,
    packageInfo: {
      ...asRecord(data.packageInfo),
      ...packageInfo,
    },
    variants: asArray(data.variants).map((entry, index) => {
      const variant = asRecord(entry);
      const skuId =
        scalar(
          variant.skuId ??
            variant.sku_id ??
            variant.productId ??
            variant.product_id ??
            variant.id,
        ) || `sku-${index + 1}`;
      if (!selectedSkuIds.has(skuId)) return entry;
      return {
        ...variant,
        packageInfo: {
          ...asRecord(variant.packageInfo),
          ...packageInfo,
        },
      };
    }),
  };
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
  const selectedPackageInfo =
    mode === "single" && selected[0]
      ? asRecord(
          selected[0].raw.packageInfo ??
            selected[0].raw.packaging ??
            selected[0].raw.package,
        )
      : {};
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
          ...(Object.keys(selectedPackageInfo).length
            ? { packageInfo: selectedPackageInfo }
            : {}),
        }
      : { selectedVariant: null, packageInfo: null }),
  };
}
