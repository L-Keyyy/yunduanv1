import {
  BROWSER_AI_PROVIDER_ID,
  BROWSER_AI_PROVIDER_NAME,
  getBrowserAiModels,
} from "@/lib/browser-ai/client";
import { handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function modelLabel(modelId: string) {
  const labels: Record<string, string> = {
    "gpt-instant": "GPT Instant",
    "gpt-thinking": "GPT Thinking",
    "gpt-pro": "GPT Pro",
    "gpt-image-1.5": "GPT Image 1.5",
    "doubao-web": "豆包网页版（免费）",
    "doubao-image-web": "豆包网页版生图 / 改图（免费）",
  };
  return labels[modelId] || modelId;
}

export async function GET() {
  try {
    const browserAi = await getBrowserAiModels();
    return ok({
      id: BROWSER_AI_PROVIDER_ID,
      name: BROWSER_AI_PROVIDER_NAME,
      isActive: false,
      source: "browser" as const,
      runtimeStatus: browserAi.runtimeStatus,
      runtimeMessage: browserAi.runtimeMessage,
      models: browserAi.models.map((model) => ({
        modelId: model.id,
        label: modelLabel(model.id),
        capabilities:
          model.type === "image"
            ? { image_gen: true, image_edit: true }
            : { text: true, structured_output: true, vision: true },
        isAvailable:
          model.ownedBy !== "doubao_web" || browserAi.doubaoServiceReady,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
