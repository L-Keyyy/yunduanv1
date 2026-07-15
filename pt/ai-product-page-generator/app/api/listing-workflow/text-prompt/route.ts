import { NextRequest } from "next/server";
import { z } from "zod";

import {
  BROWSER_AI_PROVIDER_ID,
  BROWSER_AI_PROVIDER_NAME,
  generateBrowserText,
  isBrowserAiProvider,
} from "@/lib/browser-ai/client";
import { DEFAULT_LISTING_TEXT_SYSTEM_PROMPT } from "@/lib/listing-workflow/text-prompts";
import { mapOzonAiResponse } from "@/lib/ozon/ai-response-mapper";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  scrapedData: z.record(z.string(), z.unknown()),
  providerId: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
  systemPrompt: z.string().trim().max(8000).optional(),
});

function modelCanGenerateText(model: {
  capabilities: Record<string, unknown>;
  isAvailable?: boolean;
}) {
  const capabilities = model.capabilities ?? {};
  const imageOnly =
    Boolean(capabilities.image_gen || capabilities.image_edit) &&
    !capabilities.text;
  return (
    model.isAvailable !== false &&
    Boolean(
      capabilities.text ||
        capabilities.structured_output ||
        capabilities.vision,
    ) &&
    !imageOnly
  );
}

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    const systemPrompt =
      input.systemPrompt?.trim() || DEFAULT_LISTING_TEXT_SYSTEM_PROMPT;
    const userPrompt = `${input.prompt}\n\n${JSON.stringify(input.scrapedData, null, 2)}`;

    let text: string;
    let providerId: string;
    let providerName: string;

    if (isBrowserAiProvider(input.providerId)) {
      text = await generateBrowserText({
        model: input.model,
        systemPrompt,
        userPrompt,
      });
      providerId = BROWSER_AI_PROVIDER_ID;
      providerName = BROWSER_AI_PROVIDER_NAME;
    } else {
      const { provider, adapter } = await getProviderAdapter(input.providerId);
      const selectedModel = provider.models.find(
        (model) => model.modelId === input.model,
      );
      if (!selectedModel || !modelCanGenerateText(selectedModel)) {
        throw new Error(
          selectedModel
            ? "当前选择的模型不支持文本生成。"
            : "当前 Provider 中没有找到这个文本模型。",
        );
      }

      const completion = await adapter.generateText({
        model: input.model,
        timeoutMs: 120_000,
        systemPrompt,
        userPrompt,
        monitor: {
          operation: "listing_workflow_auto_text_prompt",
        },
      });
      text = completion.text.trim();
      providerId = provider.id;
      providerName = provider.name;
    }

    if (!text) {
      throw new Error("文本模型没有返回有效回答。");
    }
    const ozonMapping = mapOzonAiResponse(text);

    return ok({
      text,
      providerId,
      providerName,
      model: input.model,
      generatedAt: new Date().toISOString(),
      ozonMapping: ozonMapping.recognized ? ozonMapping : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
