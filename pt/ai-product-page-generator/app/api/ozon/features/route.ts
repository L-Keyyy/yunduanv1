import { NextRequest } from "next/server";

import { getOzonFeatureSnapshot } from "@/lib/ozon/snapshot";
import { handleRouteError, ok } from "@/lib/utils/route";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const snapshot = await getOzonFeatureSnapshot({
      categoryId: searchParams.get("categoryId") ?? undefined,
      query: searchParams.get("q") ?? undefined,
    });

    return ok(snapshot);
  } catch (error) {
    return handleRouteError(error);
  }
}
