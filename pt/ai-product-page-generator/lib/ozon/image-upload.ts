import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { ozonSellerRequest } from "@/lib/ozon/client";
import { ensurePermanentWorkflowImageUrls } from "@/lib/listing-workflow/public-image-host";
import {
  buildOzonProductImportPayload,
  type OzonPayloadFeatureInput,
} from "@/lib/ozon/product-import-payload";

type JsonRecord = Record<string, unknown>;

type OzonProductInfoItem = {
  id?: number;
  offer_id?: string;
  product_id?: number;
  price?: string;
  currency_code?: string;
};

type OzonProductAttributesItem = {
  offer_id?: string;
  product_id?: number;
  description_category_id?: number;
  type_id?: number;
  name?: string;
  depth?: number;
  width?: number;
  height?: number;
  dimension_unit?: string;
  weight?: number;
  weight_unit?: string;
  attributes?: Array<Record<string, unknown>>;
  complex_attributes?: Array<Record<string, unknown>>;
};

type OzonImportInfoItem = {
  offer_id?: string;
  status?: string;
  errors?: unknown[];
  product_id?: number;
};

type OzonPictureInfoItem = {
  product_id?: number;
  primary_photo?: string[];
  photo?: string[];
  errors?: Array<{ message?: string; url?: string }>;
};

export type OzonImageUploadResult = {
  status: "uploaded" | "processing";
  method: "pictures-import" | "product-import";
  taskId: number | null;
  productId: number;
  offerId: string;
  imageCount: number;
  primaryImageUrl: string;
  imageUrls: string[];
  submittedAt: string;
  verifiedAt: string | null;
  pictureErrors: Array<{ message?: string; url?: string }>;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uniquePublicImageUrls(values: unknown[]) {
  return [...new Set(values.flatMap((value) => {
    const url = text(value);
    return /^https?:\/\//i.test(url) ? [url] : [];
  }))].slice(0, 30);
}

function itemImageUrls(item: {
  imageUrl: string | null;
  scrapedData: Prisma.JsonValue;
  workflowData: Prisma.JsonValue | null;
}) {
  const scrapedData = record(item.scrapedData);
  const workflowData = record(item.workflowData);
  const workflowImages = record(
    workflowData.workflowImages || scrapedData.workflowImages,
  );
  const workflowItems = Array.isArray(workflowImages.items)
    ? workflowImages.items.map(record).map((entry) => entry.url)
    : [];
  const candidates = [
    ...workflowItems,
    ...(Array.isArray(workflowImages.selectedImageUrls)
      ? workflowImages.selectedImageUrls
      : []),
    ...(Array.isArray(scrapedData.imageUrls) ? scrapedData.imageUrls : []),
    ...(Array.isArray(scrapedData.images) ? scrapedData.images : []),
    ...(Array.isArray(scrapedData.gallery) ? scrapedData.gallery : []),
    item.imageUrl,
  ];
  return uniquePublicImageUrls(candidates);
}

function storedOzonIdentity(item: {
  offerId: string;
  scrapedData: Prisma.JsonValue;
  aiResponse: Prisma.JsonValue | null;
}) {
  const aiResponse = record(item.aiResponse);
  const ozonImport = record(aiResponse.ozonImport);
  const scrapedData = record(item.scrapedData);
  return {
    productId:
      positiveInteger(ozonImport.productId) ??
      positiveInteger(scrapedData.ozonProductId) ??
      positiveInteger(scrapedData.productId),
    offerId: text(ozonImport.offerId) || item.offerId,
  };
}

async function patchWorkflowUploadState(
  itemId: string | undefined,
  state: JsonRecord,
) {
  if (!itemId) return;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await prisma.listingWorkflowItem.findUnique({
      where: { id: itemId },
    });
    if (!current) return;
    const aiResponse = record(current.aiResponse);
    const scrapedData = record(current.scrapedData);
    const workflowData = record(current.workflowData);
    const imageWorkflow = record(
      workflowData.imageWorkflow || scrapedData.imageWorkflow,
    );
    const updated = await prisma.listingWorkflowItem.updateMany({
      where: { id: current.id, updatedAt: current.updatedAt },
      data: {
        aiResponse: {
          ...aiResponse,
          ozonImageUpload: state,
        } as Prisma.InputJsonValue,
        workflowData: {
          ...workflowData,
          imageWorkflow: {
            ...imageWorkflow,
            ozonUploadStatus: state.status,
            ozonUploadError: state.error ?? null,
            ozonUploadUpdatedAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 1) return;
  }
  throw new Error("Ozon 图片上传状态并发写入超时");
}

async function resolveProductId(offerId: string) {
  if (!offerId) return null;
  const response = await ozonSellerRequest<{ items?: OzonProductInfoItem[] }>(
    "/v3/product/info/list",
    { offer_id: [offerId] },
    { timeoutMs: 60_000 },
  );
  const item = (response.items ?? []).find(
    (candidate) => candidate.offer_id === offerId,
  ) ?? response.items?.[0];
  return positiveInteger(item?.product_id) ?? positiveInteger(item?.id);
}

function importTaskId(payload: unknown) {
  const result = record(record(payload).result);
  return positiveInteger(result.task_id);
}

function importInfoItems(payload: unknown): OzonImportInfoItem[] {
  const result = record(record(payload).result);
  return Array.isArray(result.items)
    ? (result.items as OzonImportInfoItem[])
    : [];
}

function itemCategory(item: {
  aiResponse: Prisma.JsonValue | null;
}) {
  const aiResponse = record(item.aiResponse);
  const quickMode = record(aiResponse.quickMode);
  const categoryMatch = record(aiResponse.categoryMatch);
  const candidates = [
    record(quickMode.category),
    record(categoryMatch.category),
    categoryMatch,
  ];
  let descriptionCategoryId: number | null = null;
  let typeId: number | null = null;
  for (const candidate of candidates) {
    descriptionCategoryId ??= positiveInteger(candidate.descriptionCategoryId);
    typeId ??= positiveInteger(candidate.typeId);
  }
  return { descriptionCategoryId, typeId };
}

function itemFeatures(value: Prisma.JsonValue | null): OzonPayloadFeatureInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const feature = record(entry);
    const attributeId = text(feature.attributeId);
    const group = text(feature.group);
    if (
      !attributeId ||
      (group !== "base" && group !== "category" && group !== "source")
    ) {
      return [];
    }
    return [{
      ...feature,
      attributeId,
      group,
      value: typeof feature.value === "string" ? feature.value : "",
      optionMappings: Array.isArray(feature.optionMappings)
        ? feature.optionMappings
        : undefined,
      ozonAttributeValues: Array.isArray(feature.ozonAttributeValues)
        ? feature.ozonAttributeValues
        : undefined,
    } as unknown as OzonPayloadFeatureInput];
  });
}

async function existingProductImportPayload(
  offerId: string,
  productId: number,
  imageUrls: string[],
) {
  const productFilter = offerId
    ? { offer_id: [offerId] }
    : { product_id: [String(productId)] };
  const [infoResponse, attributesResponse] = await Promise.all([
    ozonSellerRequest<{ items?: OzonProductInfoItem[] }>(
      "/v3/product/info/list",
      productFilter,
      { timeoutMs: 60_000 },
    ),
    ozonSellerRequest<{ result?: OzonProductAttributesItem[] }>(
      "/v4/product/info/attributes",
      {
        filter: {
          ...productFilter,
          visibility: "ALL",
        },
        limit: 100,
      },
      { timeoutMs: 60_000 },
    ),
  ]);
  const info = (infoResponse.items ?? []).find(
    (candidate) => candidate.offer_id === offerId,
  ) ?? infoResponse.items?.[0];
  const attributes = (attributesResponse.result ?? []).find(
    (candidate) => candidate.offer_id === offerId,
  ) ?? attributesResponse.result?.[0];
  if (!info || !attributes) return null;

  return {
    items: [{
      description_category_id: attributes.description_category_id,
      type_id: attributes.type_id,
      price: info.price,
      offer_id: info.offer_id || offerId,
      name: attributes.name,
      currency_code: info.currency_code,
      depth: attributes.depth,
      width: attributes.width,
      height: attributes.height,
      dimension_unit: attributes.dimension_unit,
      weight: attributes.weight,
      weight_unit: attributes.weight_unit,
      primary_image: imageUrls[0],
      images: imageUrls.slice(1, 30),
      attributes: attributes.attributes ?? [],
      ...(attributes.complex_attributes?.length
        ? { complex_attributes: attributes.complex_attributes }
        : {}),
    }],
  };
}

async function localProductImportPayload(
  item: {
    aiResponse: Prisma.JsonValue | null;
    features: Prisma.JsonValue | null;
  } | null,
  imageUrls: string[],
) {
  if (!item) return null;
  const built = buildOzonProductImportPayload({
    category: itemCategory(item),
    features: itemFeatures(item.features),
    images: {
      primary_image: imageUrls[0],
      images: imageUrls.slice(1, 30),
    },
  });
  if (built.errors.length) {
    throw new Error(`Ozon 图片更新预检失败：${built.errors.join("；")}`);
  }
  return built.payload;
}

async function waitForProductImport(taskId: number, offerId: string) {
  const deadline = Date.now() + 120_000;
  await sleep(3_000);
  while (Date.now() < deadline) {
    const response = await ozonSellerRequest<Record<string, unknown>>(
      "/v1/product/import/info",
      { task_id: taskId },
      { timeoutMs: 60_000 },
    );
    const items = importInfoItems(response);
    const terminal = items.length > 0 && items.every(
      (item) => item.status === "imported" || item.status === "failed",
    );
    if (terminal) {
      const target = items.find((item) => item.offer_id === offerId) ?? items[0];
      if (target?.status !== "imported") {
        throw new Error(
          `Ozon 商品图片更新失败：${JSON.stringify(target?.errors ?? target ?? items)}`,
        );
      }
      return {
        terminal: true,
        productId: positiveInteger(target.product_id),
      };
    }
    await sleep(4_000);
  }
  return { terminal: false, productId: null };
}

async function importPicturesThroughProduct(
  item: {
    aiResponse: Prisma.JsonValue | null;
    features: Prisma.JsonValue | null;
  } | null,
  offerId: string,
  productId: number,
  imageUrls: string[],
) {
  const payload =
    await existingProductImportPayload(offerId, productId, imageUrls) ??
    await localProductImportPayload(item, imageUrls);
  if (!payload) {
    throw new Error("缺少用于更新 Ozon 图片的商品资料");
  }
  const response = await ozonSellerRequest<Record<string, unknown>>(
    "/v3/product/import",
    payload,
    { timeoutMs: 120_000 },
  );
  const taskId = importTaskId(response);
  if (!taskId) {
    throw new Error("Ozon 已接收图片更新请求，但没有返回有效的 task_id");
  }
  const status = await waitForProductImport(taskId, offerId);
  return {
    taskId,
    terminal: status.terminal,
    productId: status.productId ?? productId,
  };
}

async function verifyPictures(productId: number, primaryImageUrl: string) {
  const deadline = Date.now() + 60_000;
  let latest: OzonPictureInfoItem | null = null;
  await sleep(5_000);
  while (Date.now() < deadline) {
    const response = await ozonSellerRequest<{ items?: OzonPictureInfoItem[] }>(
      "/v2/product/pictures/info",
      { product_id: [String(productId)] },
      { timeoutMs: 60_000 },
    );
    latest = (response.items ?? []).find(
      (item) => positiveInteger(item.product_id) === productId,
    ) ?? response.items?.[0] ?? null;
    const errors = latest?.errors ?? [];
    if (errors.length > 0) {
      throw new Error(
        `Ozon 图片处理失败：${errors.map((error) => error.message || error.url || "未知错误").join("；")}`,
      );
    }
    if ((latest?.primary_photo ?? []).includes(primaryImageUrl)) {
      return { verified: true, item: latest };
    }
    await sleep(5_000);
  }
  return { verified: false, item: latest };
}

export async function uploadListingWorkflowImagesToOzon(input: {
  listingWorkflowItemId?: string;
  offerId?: string;
  productId?: number | string | null;
  imageUrls?: string[];
}) {
  const item = input.listingWorkflowItemId
    ? await prisma.listingWorkflowItem.findUnique({
        where: { id: input.listingWorkflowItemId },
      })
    : null;
  if (input.listingWorkflowItemId && !item) {
    throw new Error("商品记录不存在，Ozon 图片上传已停止");
  }

  const storedIdentity = item
    ? storedOzonIdentity(item)
    : { productId: null, offerId: "" };
  const offerId = text(input.offerId) || storedIdentity.offerId;
  const requestedImageUrls = input.imageUrls?.length
    ? uniquePublicImageUrls(input.imageUrls)
    : item
      ? itemImageUrls(item)
      : [];
  const imageUrls = requestedImageUrls.length
    ? await ensurePermanentWorkflowImageUrls(requestedImageUrls)
    : [];
  if (imageUrls.length === 0) {
    throw new Error("没有可供 Ozon 读取的公网 JPG/PNG 图片地址");
  }

  let productId = positiveInteger(input.productId) ?? storedIdentity.productId;
  await patchWorkflowUploadState(input.listingWorkflowItemId, {
    status: "uploading",
    productId,
    offerId,
    imageCount: imageUrls.length,
    primaryImageUrl: imageUrls[0],
    startedAt: new Date().toISOString(),
  });

  try {
    productId ??= await resolveProductId(offerId);
    if (!productId) {
      throw new Error(`Ozon 店铺中没有找到 offer_id=${offerId || "空"} 对应的商品`);
    }

    let method: OzonImageUploadResult["method"] = "pictures-import";
    let taskId: number | null = null;
    let importTerminal = true;
    try {
      await ozonSellerRequest<Record<string, unknown>>(
        "/v1/product/pictures/import",
        {
          product_id: productId,
          images: imageUrls,
        },
        { timeoutMs: 120_000 },
      );
    } catch (pictureImportError) {
      const message = pictureImportError instanceof Error
        ? pictureImportError.message
        : String(pictureImportError);
      if (!/Ozon Seller API 400:/i.test(message)) throw pictureImportError;
      method = "product-import";
      const fallback = await importPicturesThroughProduct(
        item,
        offerId,
        productId,
        imageUrls,
      );
      taskId = fallback.taskId;
      importTerminal = fallback.terminal;
      productId = fallback.productId;
    }
    const submittedAt = new Date().toISOString();
    const verification = importTerminal
      ? await verifyPictures(productId, imageUrls[0])
      : { verified: false, item: null };
    const result: OzonImageUploadResult = {
      status: verification.verified ? "uploaded" : "processing",
      method,
      taskId,
      productId,
      offerId,
      imageCount: imageUrls.length,
      primaryImageUrl: imageUrls[0],
      imageUrls,
      submittedAt,
      verifiedAt: verification.verified ? new Date().toISOString() : null,
      pictureErrors: verification.item?.errors ?? [],
    };
    await patchWorkflowUploadState(input.listingWorkflowItemId, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ozon 图片上传失败";
    await patchWorkflowUploadState(input.listingWorkflowItemId, {
      status: "failed",
      productId,
      offerId,
      imageCount: imageUrls.length,
      primaryImageUrl: imageUrls[0],
      error: message,
      failedAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
}
