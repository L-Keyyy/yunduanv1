import { NextRequest } from "next/server";
import { z } from "zod";

import { generateListingWorkflowImage } from "@/lib/listing-workflow/image-generation";
import { runProcessingFifo } from "@/lib/listing-workflow/processing-fifo";
import {
  persistWorkflowGenerationFailure,
  persistWorkflowGenerationResult,
  type ProcessingWorkflowContext,
} from "@/lib/listing-workflow/processing-state";
import { uploadListingWorkflowImagesToOzon } from "@/lib/ozon/image-upload";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1),
  prompt: z.string().trim().min(4).max(5000),
  aspectRatio: z.enum(["1:1", "3:4", "9:16"]).default("1:1"),
  referenceImages: z.array(z.string().min(1)).max(4).optional().default([]),
  useReferenceImages: z.boolean().default(true),
  splitGrid: z.boolean().default(false),
  workflowItemId: z.string().trim().min(1).max(200).optional().nullable(),
  workflowRunId: z.string().trim().min(1).max(300).optional().nullable(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch (error) {
    return handleRouteError(error);
  }
  const workflowContext: ProcessingWorkflowContext | null =
    input.workflowItemId && input.workflowRunId
      ? { itemId: input.workflowItemId, runId: input.workflowRunId }
      : null;

  let result: Awaited<ReturnType<typeof generateListingWorkflowImage>>;
  try {
    result = await runProcessingFifo("generation", workflowContext, async () => {
      try {
        const generated = await generateListingWorkflowImage(
          input,
          request.nextUrl.origin,
        );
        await persistWorkflowGenerationResult(workflowContext, generated);
        return generated;
      } catch (error) {
        if (workflowContext) {
          const message = error instanceof Error ? error.message : "主图生成请求异常";
          await persistWorkflowGenerationFailure(workflowContext, message).catch(
            () => undefined,
          );
        }
        throw error;
      }
    });
  } catch (error) {
    return handleRouteError(error);
  }

  let ozonUpload = null;
  const warnings = [...(result.warnings ?? [])];
  if (input.workflowItemId && result.gridImages?.length === 4) {
    try {
      ozonUpload = await uploadListingWorkflowImagesToOzon({
        listingWorkflowItemId: input.workflowItemId,
      });
    } catch (error) {
      warnings.push(
        `四宫格已裁剪并保存，Ozon 自动上传失败：${
          error instanceof Error ? error.message : "未知错误"
        }`,
      );
    }
  }
  return ok({ ...result, warnings, ozonUpload });
}
