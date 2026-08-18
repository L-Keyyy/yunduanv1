import { createHash } from "crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { sanitizeCollectedProductJson } from "@/lib/listing-workflow/ai-product-json";
import { extensionAiFollowSourceImages } from "@/lib/listing-workflow/extension-ai-follow-images";
import { generateListingWorkflowImage } from "@/lib/listing-workflow/image-generation";
import { readListingWorkflowPreferences } from "@/lib/listing-workflow/preferences";
import {
  persistWorkflowGenerationFailure,
  persistWorkflowGenerationResult,
} from "@/lib/listing-workflow/processing-state";

export type ExtensionAiFollowInput = {
  offerId: string;
  sourceUrl: string;
  productId?: string | number | null;
  title?: string | null;
  scrapedJson: Record<string, unknown>;
  currentPrice?: string | null;
  oldPrice?: string | null;
  minPrice?: string | null;
  costPrice?: string | null;
  currency?: string | null;
  storeId?: string | null;
  mergeValue?: string | null;
};

type ManagedSourceImage = {
  id: string;
  name: string;
  url: string;
  label: string;
  source: "crawler";
};

const activeJobs = new Map<string, Promise<void>>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  return text(value) || null;
}

function imageIdentity(url: string) {
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function imageExtension(url: string) {
  return (
    url.match(/\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i)?.[1] || "jpg"
  ).replace("jpeg", "jpg");
}

function managedSourceImages(urls: string[]): ManagedSourceImage[] {
  return urls.map((url, index) => ({
    id: `extension-source:${imageIdentity(url)}`,
    name: `ozon-source-${String(index + 1).padStart(2, "0")}.${imageExtension(url)}`,
    url,
    label: index === 0 ? "原商品主图" : `原商品附图 ${index}`,
    source: "crawler",
  }));
}

function notes(value: Prisma.JsonValue | null, next: string) {
  const existing = Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
  return [...new Set([...existing, next])].slice(0, 100);
}

function configuredImagePrompt(configuredPrompt: string, title: string) {
  const base = configuredPrompt.trim();
  return [base, `本次参考商品：${title}。保持参考图中的商品身份、结构、颜色和关键细节一致。`]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 5000);
}

async function prepareExtensionAiFollow(input: ExtensionAiFollowInput) {
  const existing = await prisma.listingWorkflowItem.findUnique({
    where: { offerId: input.offerId },
  });
  const scrapedData = sanitizeCollectedProductJson(input.scrapedJson);
  const imageUrls = extensionAiFollowSourceImages(scrapedData);
  if (!imageUrls.length) {
    throw new Error("当前商品没有可供 AI 参考的主图");
  }

  const sourceImages = managedSourceImages(imageUrls);
  const mainImage = sourceImages[0];
  const preferences = await readListingWorkflowPreferences();
  const title =
    nullableText(input.title) ||
    nullableText(scrapedData.title) ||
    existing?.title ||
    `Ozon 商品 ${input.productId || input.offerId}`;
  const runId = `extension-ai-follow:${Date.now()}:${imageIdentity(
    `${input.offerId}:${mainImage.url}`,
  )}`;
  const now = new Date().toISOString();
  const previousWorkflowData = asRecord(existing?.workflowData);
  const prompt = configuredImagePrompt(
    preferences.stageAiPrompts.imageGeneration.prompt,
    title,
  );
  const workflowData = {
    ...previousWorkflowData,
    workflowImages: {
      items: sourceImages,
      selectedImageIds: [mainImage.id],
      selectedImageUrls: [mainImage.url],
      primaryImageUrl: mainImage.url,
      updatedAt: now,
    },
    imageWorkflow: {
      runId,
      status: "running",
      phase: "generating",
      totalImages: sourceImages.length,
      translationTotalImages: 0,
      translatedCount: 0,
      translatedSuccessCount: 0,
      translationFailedCount: 0,
      translationSkippedCount: 0,
      translationStatus: "skipped",
      generationStatus: "running",
      featureStatus: "skipped",
      generatedImageId: null,
      generatedImageUrl: null,
      autoImageWorkflowNotes: [],
      sourceImageSignature: sourceImages
        .map((image) => `${image.id}:${image.url}`)
        .join("|"),
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    },
    extensionAiFollow: {
      enabled: true,
      source: "ozon-operation-bot",
      productId: input.productId ?? null,
      storeId: nullableText(input.storeId),
      mergeValue: nullableText(input.mergeValue),
      providerId: preferences.imageModel.providerId,
      modelId: preferences.imageModel.modelId,
      requestedAt: now,
    },
  };

  const item = await prisma.listingWorkflowItem.upsert({
    where: { offerId: input.offerId },
    create: {
      stage: "PROCESSING",
      status: "AI_RUNNING",
      sourceUrl: input.sourceUrl,
      sourcePlatform: "ozon",
      title,
      offerId: input.offerId,
      imageUrl: mainImage.url,
      currentPrice: nullableText(input.currentPrice),
      oldPrice: nullableText(input.oldPrice),
      minPrice: nullableText(input.minPrice),
      costPrice: nullableText(input.costPrice),
      currency: nullableText(input.currency) || "CNY",
      scrapedData: scrapedData as Prisma.InputJsonValue,
      workflowData: workflowData as Prisma.InputJsonValue,
      notes: [
        "由 Ozon 扩展勾选“AI模型处理图片”后进入加工阶段。",
      ] as Prisma.InputJsonValue,
    },
    update: {
      stage: "PROCESSING",
      status: "AI_RUNNING",
      sourceUrl: input.sourceUrl,
      sourcePlatform: "ozon",
      title,
      imageUrl: mainImage.url,
      currentPrice: nullableText(input.currentPrice),
      oldPrice: nullableText(input.oldPrice),
      minPrice: nullableText(input.minPrice),
      costPrice: nullableText(input.costPrice),
      currency: nullableText(input.currency) || existing?.currency || "CNY",
      scrapedData: scrapedData as Prisma.InputJsonValue,
      workflowData: workflowData as Prisma.InputJsonValue,
      notes: notes(
        existing?.notes ?? null,
        "由 Ozon 扩展勾选“AI模型处理图片”后重新进入加工阶段。",
      ) as Prisma.InputJsonValue,
    },
  });

  return {
    item,
    runId,
    mainImageUrl: mainImage.url,
    providerId: preferences.imageModel.providerId,
    model: preferences.imageModel.modelId,
    prompt,
    aspectRatio: preferences.stageAiPrompts.imageGeneration.aspectRatio,
    useReferenceImages:
      preferences.stageAiPrompts.imageGeneration.useReference,
  };
}

async function runExtensionAiFollowGeneration(
  prepared: Awaited<ReturnType<typeof prepareExtensionAiFollow>>,
  requestOrigin: string,
) {
  const context = { itemId: prepared.item.id, runId: prepared.runId };
  try {
    const result = await generateListingWorkflowImage(
      {
        providerId: prepared.providerId,
        model: prepared.model,
        prompt: prepared.prompt,
        aspectRatio: prepared.aspectRatio,
        referenceImages: prepared.useReferenceImages
          ? [prepared.mainImageUrl]
          : [],
        useReferenceImages: prepared.useReferenceImages,
        splitGrid: true,
      },
      requestOrigin,
    );
    await persistWorkflowGenerationResult(context, result);
  } catch (error) {
    await persistWorkflowGenerationFailure(
      context,
      error instanceof Error ? error.message : "扩展 AI 图片生成异常",
    );
  }
}

export async function enqueueExtensionAiFollow(
  input: ExtensionAiFollowInput,
  requestOrigin: string,
) {
  const active = activeJobs.get(input.offerId);
  if (active) {
    const item = await prisma.listingWorkflowItem.findUnique({
      where: { offerId: input.offerId },
    });
    if (item) {
      return { item, queued: true, reused: true };
    }
  }

  const prepared = await prepareExtensionAiFollow(input);
  const job = runExtensionAiFollowGeneration(prepared, requestOrigin).finally(
    () => {
      if (activeJobs.get(input.offerId) === job) {
        activeJobs.delete(input.offerId);
      }
    },
  );
  activeJobs.set(input.offerId, job);

  return { item: prepared.item, queued: true, reused: false };
}
