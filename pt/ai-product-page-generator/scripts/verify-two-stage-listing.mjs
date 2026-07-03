#!/usr/bin/env node

const baseUrl = process.env.WORKFLOW_BASE_URL || "http://127.0.0.1:3000";
const providerId = process.env.WORKFLOW_PROVIDER_ID || "browser-webai";
const model = process.env.WORKFLOW_MODEL || "gpt-instant";
const requestedItemId = process.env.WORKFLOW_ITEM_ID || "";

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(
      `${options.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body.data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function featureValue(features, attributeId) {
  return features.find((feature) => feature.attributeId === attributeId)?.value || "";
}

function mergeDraftFeatures(existingFeatures, generatedFeatures) {
  const generatedBase = new Map(
    generatedFeatures
      .filter((feature) => feature.group === "base")
      .map((feature) => [feature.attributeId, feature]),
  );
  const existingBase = existingFeatures.filter((feature) => feature.group === "base");
  const mergedBase = existingBase.map((feature) =>
    feature.attributeId === "base:category_type"
      ? generatedBase.get(feature.attributeId) || feature
      : feature,
  );
  const existingBaseIds = new Set(mergedBase.map((feature) => feature.attributeId));
  for (const feature of generatedBase.values()) {
    if (!existingBaseIds.has(feature.attributeId)) mergedBase.push(feature);
  }
  return [
    ...mergedBase,
    ...generatedFeatures.filter((feature) => feature.group === "category"),
  ];
}

function withPreviewDefaults(features) {
  const defaults = new Map([
    ["base:price", "29.90"],
    ["base:old_price", "39.90"],
    ["base:min_price", "25.90"],
    ["base:depth", "100"],
    ["base:width", "100"],
    ["base:height", "100"],
  ]);
  return features.map((feature) =>
    defaults.has(feature.attributeId) && !feature.value
      ? { ...feature, value: defaults.get(feature.attributeId) }
      : feature,
  );
}

function readImages(features) {
  const value = featureValue(features, "base:images");
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const items = await api("/api/listing-workflow/items");
const item =
  items.find((candidate) => candidate.id === requestedItemId) ||
  items.find((candidate) => candidate.sourcePlatform === "1688") ||
  items[0];
assert(item, "没有找到可用于验证的商品工作流记录。");

console.log(`1/5 第一阶段类目匹配：${item.id}`);
const categoryResult = await api("/api/listing-workflow/category-match", {
  method: "POST",
  body: JSON.stringify({
    scrapedData: item.scrapedData,
    providerId,
    model,
  }),
});
assert(categoryResult.aiStatus?.ok, categoryResult.aiStatus?.message || "第一阶段 AI 匹配失败。");
assert(categoryResult.category?.id, "第一阶段没有返回本地 Ozon 类目记录。");
assert(categoryResult.preparedProduct, "第一阶段没有返回清洗后的商品事实。");
const preparedText = JSON.stringify(categoryResult.preparedProduct);
assert(!/https?:|\/\//i.test(preparedText), "清洗后的商品事实仍包含 URL。");
assert(
  (categoryResult.promptAudit?.removedImageReferenceCount || 0) > 0,
  "第一阶段没有记录被过滤的图片引用。",
);
assert(
  (categoryResult.promptAudit?.removedUrlCount || 0) > 0,
  "第一阶段没有记录被过滤的 URL。",
);

console.log(
  `    类目：${categoryResult.category.label} / ${categoryResult.category.descriptionCategoryId} / ${categoryResult.category.typeId}`,
);
console.log(
  `    清洗：${categoryResult.promptAudit.rawBytes} -> ${categoryResult.promptAudit.preparedBytes} bytes，过滤图片 ${categoryResult.promptAudit.removedImageReferenceCount}、URL ${categoryResult.promptAudit.removedUrlCount}`,
);

console.log("2/5 第二阶段类目字段匹配");
const featureResult = await api("/api/listing-workflow/feature-draft", {
  method: "POST",
  body: JSON.stringify({
    scrapedData: item.scrapedData,
    preparedProduct: categoryResult.preparedProduct,
    categoryId: categoryResult.category.id,
    providerId,
    model,
  }),
});
assert(featureResult.aiStatus?.ok, featureResult.aiStatus?.message || "第二阶段 AI 匹配失败。");
assert(
  (featureResult.promptAudit?.returnedAttributeCount || 0) > 0,
  "第二阶段没有返回任何当前类目的 attributeId。",
);
assert(
  JSON.stringify(featureResult.preparedProduct) === preparedText,
  "第二阶段没有复用第一阶段的清洗商品事实。",
);

const categoryFeatures = featureResult.features.filter(
  (feature) => feature.group === "category",
);
for (const attributeId of ["85", "4389", "8229"]) {
  const feature = categoryFeatures.find(
    (candidate) => candidate.attributeId === attributeId,
  );
  assert(feature?.value, `关键 Ozon 字段 ${attributeId} 没有值。`);
  assert(
    feature.ozonAttributeValues?.[0]?.dictionary_value_id,
    `关键 Ozon 字段 ${attributeId} 没有匹配到字典 ID。`,
  );
}
const technicalValues = categoryFeatures.filter(
  (feature) =>
    feature.value &&
    /pdf|видео|video|richконтент|кодпродавца|маркировк|тнвэд/i.test(
      `${feature.label} ${feature.ozonCode || ""}`,
    ),
);
assert(
  technicalValues.length === 0,
  `技术字段被错误自动填写：${technicalValues.map((feature) => feature.label).join(", ")}`,
);
console.log(
  `    返回字段：${featureResult.promptAudit.returnedAttributeCount}/${featureResult.promptAudit.attributeCount}，必填 ${featureResult.promptAudit.requiredFilled}/${featureResult.promptAudit.requiredCount}`,
);

console.log("3/5 生成 Ozon 导入 JSON 预览");
const mergedFeatures = mergeDraftFeatures(item.features || [], featureResult.features);
const previewFeatures = withPreviewDefaults(mergedFeatures);
const preview = await api("/api/listing-workflow/ozon-import", {
  method: "POST",
  body: JSON.stringify({
    action: "preview",
    category: {
      descriptionCategoryId: categoryResult.category.descriptionCategoryId,
      typeId: categoryResult.category.typeId,
    },
    features: previewFeatures,
    images: readImages(mergedFeatures),
  }),
});
assert(preview.errors?.length === 0, `Ozon 预览校验失败：${preview.errors?.join("；")}`);
assert(preview.payload?.items?.length === 1, "Ozon 预览没有生成商品 item。");
assert(
  preview.payload.items[0].description_category_id ===
    categoryResult.category.descriptionCategoryId,
  "Ozon 预览 description_category_id 不一致。",
);
assert(
  preview.payload.items[0].type_id === categoryResult.category.typeId,
  "Ozon 预览 type_id 不一致。",
);
console.log(
  `    Ozon attributes：${preview.payload.items[0].attributes?.length || 0}，errors：0`,
);

console.log("4/5 保存本地加工阶段草稿");
await api(`/api/listing-workflow/items/${item.id}`, {
  method: "PATCH",
  body: JSON.stringify({
    stage: "PROCESSING",
    status: "MATCHED",
    categoryId: categoryResult.category.id,
    categoryLabel: categoryResult.category.label,
    categoryPath: categoryResult.category.path,
    features: mergedFeatures,
    aiResponse: featureResult.aiResponse || null,
    notes: featureResult.notes || [],
  }),
});
const persisted = await api(`/api/listing-workflow/items/${item.id}`);
assert(
  persisted.categoryId === categoryResult.category.id,
  "本地商品没有保存正确的类目。",
);
assert(
  persisted.features.some(
    (feature) =>
      feature.attributeId === "85" &&
      feature.ozonAttributeValues?.[0]?.dictionary_value_id,
  ),
  "本地商品没有保存 Ozon 字典 ID。",
);

console.log("5/5 验证完成");
console.log(
  JSON.stringify(
    {
      itemId: item.id,
      category: categoryResult.category,
      promptAudit: featureResult.promptAudit,
      ozonPreviewErrors: preview.errors,
      persistedFeatureCount: persisted.features.length,
      submittedToOzon: false,
    },
    null,
    2,
  ),
);
