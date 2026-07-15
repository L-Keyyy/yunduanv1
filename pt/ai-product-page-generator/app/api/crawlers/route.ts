import { NextRequest } from "next/server";
import { z } from "zod";

import { launchCrawlerAction, scanCrawlerModules } from "@/lib/crawlers/registry";
import { handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";

const launchSchema = z.object({
  action: z.enum([
    "launch_marketspider_ui",
    "launch_taobao_spider",
    "launch_jd_spider",
    "launch_1688_spider",
    "launch_cookie_helper",
  ]),
});

export async function GET() {
  try {
    const result = await scanCrawlerModules();
    return ok(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = launchSchema.parse(await request.json());
    const result = await launchCrawlerAction(parsed.action);
    return ok(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
