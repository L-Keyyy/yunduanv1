import { Prisma, type ListingWorkflowItem } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { mergeGeneratedWithOriginalAuxiliary } from "@/lib/listing-workflow/extension-ai-follow-images";

export type ProcessingWorkflowContext = {
  itemId: string;
  runId: string;
};

export type WorkflowImageGenerationResult = {
  fileName: string;
  filePath: string;
  imageUrl: string;
  warnings?: string[];
  gridImages?: Array<{
    index: number;
    label: string;
    fileName: string;
    filePath: string;
    imageUrl: string;
  }>;
};

export type WorkflowFeatureResult = {
  features: unknown[];
  variantFeatures?: unknown[];
  aiStatus: { ok: boolean; message: string };
  notes?: string[];
  aiResponse?: Record<string, unknown> | null;
};

export type WorkflowAtlasImage = {
  id: string;
  fileName: string;
  filePath: string;
  imageUrl: string;
};

type StoredItem = ListingWorkflowItem;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return Object.keys(record).length ? [record] : [];
      })
    : [];
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function workflowNotes(workflow: Record<string, unknown>, message?: string) {
  return unique([
    ...asStringArray(workflow.autoImageWorkflowNotes),
    ...(message ? [message] : []),
  ]).slice(0, 100);
}

function withoutFeatureWorkflowNotes(workflow: Record<string, unknown>) {
  return asStringArray(workflow.autoImageWorkflowNotes).filter(
    (note) => !note.startsWith("特征匹配"),
  );
}

function withoutGenerationWorkflowNotes(workflow: Record<string, unknown>) {
  return asStringArray(workflow.autoImageWorkflowNotes).filter(
    (note) => !note.startsWith("主图自动生图失败"),
  );
}

function imageUrls(images: Record<string, unknown>[]) {
  return images.flatMap((image) => {
    const url = text(image.url);
    return url ? [url] : [];
  });
}

function syncBaseFeatures(features: unknown, item: StoredItem) {
  if (!Array.isArray(features)) return features;
  const values: Record<string, string> = {
    name: item.title,
    offer_id: item.offerId,
    price: item.currentPrice ?? "",
    old_price: item.oldPrice ?? "",
    min_price: item.minPrice ?? "",
    cost_price: item.costPrice ?? "",
    currency_code: item.currency,
  };
  return features.map((entry) => {
    const feature = asRecord(entry);
    if (feature.group !== "base") return feature;
    const id = text(feature.attributeId).replace(/^base:/, "");
    const value = values[id];
    if (value === undefined) return feature;
    return {
      ...feature,
      value,
      source: "人工修改",
      status: value ? "review" : feature.required ? "missing" : "review",
    };
  });
}

function syncImageFeature(features: unknown, images: Record<string, unknown>[]) {
  if (!Array.isArray(features)) return features;
  const urls = imageUrls(images);
  const value = urls.length
    ? JSON.stringify({ primary_image: urls[0], images: urls.slice(1) })
    : "";
  return features.map((entry) => {
    const feature = asRecord(entry);
    const id = text(feature.attributeId).replace(/^base:/, "");
    if (id !== "images") return feature;
    return {
      ...feature,
      value,
      status: value ? "auto" : feature.required ? "missing" : "review",
      source: value ? "图片排序" : feature.source,
      reason: value
        ? "按当前图片顺序回填，第一张作为 Ozon 主图，其余图片按顺序上传。"
        : feature.reason,
    };
  });
}

function workflowIsTerminal(status: string, kind: "translation" | "generation" | "feature") {
  if (kind === "translation") {
    return ["done", "skipped", "partial", "failed"].includes(status);
  }
  if (kind === "generation") {
    return ["done", "skipped", "failed"].includes(status);
  }
  return ["done", "skipped", "failed"].includes(status);
}

function finalizeIfReady(
  workflow: Record<string, unknown>,
  now: string,
) {
  const translationStatus = text(workflow.translationStatus);
  const generationStatus = text(workflow.generationStatus);
  const featureStatus = text(workflow.featureStatus);
  const allTerminal =
    workflowIsTerminal(translationStatus, "translation") &&
    workflowIsTerminal(generationStatus, "generation") &&
    workflowIsTerminal(featureStatus, "feature");
  if (!allTerminal) {
    return { workflow: { ...workflow, updatedAt: now }, itemStatus: null };
  }

  const notes = asStringArray(workflow.autoImageWorkflowNotes);
  const translationOk = ["done", "skipped"].includes(translationStatus);
  const generationOk = ["done", "skipped"].includes(generationStatus);
  const featureOk = ["done", "skipped"].includes(featureStatus);
  const translatedCount = Number(workflow.translatedCount ?? 0);
  const finalStatus =
    translationOk && generationOk && featureOk && notes.length === 0
      ? "done"
      : featureStatus === "done" || generationStatus === "done" || translatedCount > 0
        ? "partial"
        : "failed";
  return {
    workflow: {
      ...workflow,
      status: finalStatus,
      phase: "done",
      error: finalStatus === "failed" ? notes[0] || "加工失败" : null,
      finishedAt: text(workflow.finishedAt) || now,
      updatedAt: now,
    },
    itemStatus:
      finalStatus === "failed"
        ? "AI_FAILED"
        : featureOk
          ? "MATCHED"
          : "AI_FAILED",
  };
}

async function updateCurrentRun(
  context: ProcessingWorkflowContext | null,
  mutate: (
    item: StoredItem,
    scrapedData: Record<string, unknown>,
    workflow: Record<string, unknown>,
  ) => Prisma.ListingWorkflowItemUpdateManyMutationInput,
) {
  if (!context) return false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await prisma.listingWorkflowItem.findUnique({
      where: { id: context.itemId },
    });
    if (!current || current.stage !== "PROCESSING") return false;
    const sourceData = asRecord(current.scrapedData);
    const workflowData = {
      ...(sourceData.workflowImages
        ? { workflowImages: sourceData.workflowImages }
        : {}),
      ...(sourceData.imageWorkflow
        ? { imageWorkflow: sourceData.imageWorkflow }
        : {}),
      ...(sourceData.skuFeatureDrafts
        ? { skuFeatureDrafts: sourceData.skuFeatureDrafts }
        : {}),
      ...asRecord(current.workflowData),
    };
    const workflow = asRecord(workflowData.imageWorkflow);
    if (text(workflow.runId) !== context.runId) return false;
    const data = mutate(current, workflowData, workflow);
    const updated = await prisma.listingWorkflowItem.updateMany({
      where: { id: current.id, updatedAt: current.updatedAt },
      data,
    });
    if (updated.count === 1) return true;
  }
  throw new Error("商品加工状态并发写入超时");
}

function workflowData(
  runtimeData: Record<string, unknown>,
  workflow: Record<string, unknown>,
  extra: Omit<Prisma.ListingWorkflowItemUpdateManyMutationInput, "workflowData" | "status"> = {},
) {
  const now = new Date().toISOString();
  const finalized = finalizeIfReady(workflow, now);
  return {
    ...extra,
    ...(finalized.itemStatus ? { status: finalized.itemStatus } : {}),
    workflowData: {
      ...runtimeData,
      imageWorkflow: finalized.workflow,
    } as Prisma.InputJsonValue,
  } satisfies Prisma.ListingWorkflowItemUpdateManyMutationInput;
}

export async function persistWorkflowGenerationResult(
  context: ProcessingWorkflowContext | null,
  result: WorkflowImageGenerationResult,
) {
  return updateCurrentRun(context, (item, scrapedData, workflow) => {
    const storedImages = asRecordArray(asRecord(scrapedData.workflowImages).items);
    const previousMainId = text(storedImages[0]?.id);
    const generatedImages =
      result.gridImages?.length === 4
        ? [...result.gridImages]
            .sort((left, right) => left.index - right.index)
            .map((image, index) => ({
              id: `generated:${image.filePath}`,
              name: image.fileName,
              url: image.imageUrl,
              label: index === 0 ? "AI 主图" : `AI 详情图 ${index}`,
              source: "generated",
            }))
        : [
            {
              id: `generated:${result.filePath}`,
              name: result.fileName,
              url: result.imageUrl,
              label: "AI 主图",
              source: "generated",
            },
          ];
    const generated = generatedImages[0];
    const images = mergeGeneratedWithOriginalAuxiliary(
      generatedImages,
      storedImages,
    );
    const urls = imageUrls(images);
    const storedWorkflowImages = asRecord(scrapedData.workflowImages);
    const previousSelectedImageIds = asStringArray(
      storedWorkflowImages.selectedImageIds,
    );
    const selectedImageIds = unique([
      ...(previousSelectedImageIds.includes(previousMainId)
        ? generatedImages.map((image) => image.id)
        : []),
      ...previousSelectedImageIds.filter((id) => id !== previousMainId),
    ]).filter((id) => images.some((image) => text(image.id) === id));
    const selected = new Set(selectedImageIds);
    const nextScrapedData = {
      ...scrapedData,
      gallery: urls,
      images: urls,
      imageUrls: urls,
      workflowImages: {
        ...storedWorkflowImages,
        items: images,
        selectedImageIds,
        selectedImageUrls: images
          .filter((image) => selected.has(text(image.id)))
          .flatMap((image) => (text(image.url) ? [text(image.url)] : [])),
        primaryImageUrl: urls[0] ?? "",
        updatedAt: new Date().toISOString(),
      },
    };
    const warnings = result.warnings?.filter(Boolean) ?? [];
    const syncedFeatures = syncImageFeature(item.features, images);
    return workflowData(
      nextScrapedData,
      {
        ...workflow,
        generationStatus: "done",
        generatedImageId: generated.id,
        generatedImageUrl: generated.url,
        generatedImageIds: generatedImages.map((image) => image.id),
        generatedImageUrls: generatedImages.map((image) => image.url),
        generatedGridCount: generatedImages.length,
        autoGeneratedMainImageAt: new Date().toISOString(),
        autoImageWorkflowNotes: unique([
          ...withoutGenerationWorkflowNotes(workflow),
          ...warnings.map((warning) => `主图生成：${warning}`),
        ]),
      },
      {
        imageUrl: generated.url,
        ...(Array.isArray(syncedFeatures)
          ? { features: syncedFeatures as Prisma.InputJsonValue }
          : {}),
      },
    );
  });
}

export async function persistWorkflowGenerationFailure(
  context: ProcessingWorkflowContext | null,
  message: string,
) {
  return updateCurrentRun(context, (_item, scrapedData, workflow) =>
    workflowData(scrapedData, {
      ...workflow,
      generationStatus: "failed",
      generatedImageId: null,
      generatedImageUrl: null,
      autoImageWorkflowNotes: workflowNotes(
        workflow,
        `主图自动生图失败：${message}`,
      ),
    }),
  );
}

export async function persistWorkflowFeatureResult(
  context: ProcessingWorkflowContext | null,
  result: WorkflowFeatureResult,
) {
  return updateCurrentRun(context, (item, scrapedData, workflow) => {
    const featureOk = Boolean(result.aiStatus.ok);
    const currentAiResponse = asRecord(item.aiResponse);
    const categoryMatch = asRecord(currentAiResponse.categoryMatch);
    const nextAiResponse = {
      ...currentAiResponse,
      ...asRecord(result.aiResponse),
      categoryMatch,
    };
    const images = asRecordArray(asRecord(scrapedData.workflowImages).items);
    const baseSynced = syncBaseFeatures(result.features, item);
    const features = syncImageFeature(baseSynced, images);
    const nextScrapedData = Array.isArray(result.variantFeatures)
      ? {
          ...scrapedData,
          skuFeatureDrafts: result.variantFeatures,
          skuFeatureDraftsUpdatedAt: new Date().toISOString(),
        }
      : scrapedData;
    return workflowData(
      nextScrapedData,
      {
        ...workflow,
        featureStatus: featureOk ? "done" : "failed",
        featureError: featureOk ? null : result.aiStatus.message,
        autoFeatureMatchedAt: new Date().toISOString(),
        autoImageWorkflowNotes: featureOk
          ? withoutFeatureWorkflowNotes(workflow)
          : workflowNotes(
              workflow,
              `特征匹配提醒：${result.aiStatus.message}`,
            ),
      },
      {
        features: features as Prisma.InputJsonValue,
        aiResponse: nextAiResponse as Prisma.InputJsonValue,
        notes: (result.notes ?? []) as Prisma.InputJsonValue,
      },
    );
  });
}

export async function persistWorkflowFeatureFailure(
  context: ProcessingWorkflowContext | null,
  message: string,
) {
  return updateCurrentRun(context, (_item, scrapedData, workflow) =>
    workflowData(scrapedData, {
      ...workflow,
      featureStatus: "failed",
      featureError: message,
      autoImageWorkflowNotes: workflowNotes(
        workflow,
        `特征匹配失败：${message}`,
      ),
    }),
  );
}

export async function persistWorkflowTranslationResult(
  context: ProcessingWorkflowContext | null,
  totalImages: number,
  outputs: WorkflowAtlasImage[],
) {
  return updateCurrentRun(context, (item, scrapedData, workflow) => {
    const storedWorkflowImages = asRecord(scrapedData.workflowImages);
    const replacements = new Map(
      outputs.map((output) => [
        output.id,
        {
          id: `translated:${output.filePath}`,
          name: output.fileName,
          url: output.imageUrl,
          label: "图集已翻译",
          source: "edited",
        },
      ]),
    );
    const images = asRecordArray(storedWorkflowImages.items).map((image) => {
      const replacement = replacements.get(text(image.id));
      return replacement ? { ...image, ...replacement } : image;
    });
    const selectedImageIds = asStringArray(storedWorkflowImages.selectedImageIds)
      .map((id) => text(replacements.get(id)?.id) || id)
      .filter((id) => images.some((image) => text(image.id) === id));
    const selected = new Set(selectedImageIds);
    const urls = imageUrls(images);
    const translatedSourceImageIds = unique([
      ...asStringArray(workflow.translatedSourceImageIds),
      ...outputs.map((output) => output.id),
    ]);
    const translatedCount = translatedSourceImageIds.length;
    const translationStatus = translatedCount >= totalImages ? "done" : "running";
    const nextScrapedData = {
      ...scrapedData,
      gallery: urls,
      images: urls,
      imageUrls: urls,
      workflowImages: {
        ...storedWorkflowImages,
        items: images,
        selectedImageIds,
        selectedImageUrls: images
          .filter((image) => selected.has(text(image.id)))
          .flatMap((image) => (text(image.url) ? [text(image.url)] : [])),
        primaryImageUrl: urls[0] ?? "",
        updatedAt: new Date().toISOString(),
      },
    };
    const syncedFeatures = syncImageFeature(item.features, images);
    return workflowData(
      nextScrapedData,
      {
        ...workflow,
        translationStatus,
        translationTotalImages: totalImages,
        translatedCount,
        translatedSuccessCount: translatedCount,
        translationFailedCount: 0,
        translationSkippedCount: 0,
        translatedSourceImageIds,
        atlasTranslation: true,
        autoTranslatedAt:
          translationStatus === "done" ? new Date().toISOString() : null,
      },
      {
        imageUrl: urls[0] ?? item.imageUrl,
        ...(Array.isArray(syncedFeatures)
          ? { features: syncedFeatures as Prisma.InputJsonValue }
          : {}),
      },
    );
  });
}

export async function persistWorkflowTranslationFailure(
  context: ProcessingWorkflowContext | null,
  totalImages: number,
  message: string,
) {
  return updateCurrentRun(context, (_item, scrapedData, workflow) => {
    const translatedCount = Number(workflow.translatedCount ?? 0);
    return workflowData(scrapedData, {
      ...workflow,
      translationStatus: translatedCount > 0 ? "partial" : "failed",
      translationTotalImages: totalImages,
      translationFailedCount: Math.max(totalImages - translatedCount, 0),
      atlasTranslation: true,
      autoImageWorkflowNotes: workflowNotes(
        workflow,
        `选中图片图集翻译失败：${message}`,
      ),
    });
  });
}
