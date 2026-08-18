import { inspectOzonErrorProducts, startOzonErrorRepair } from "@/lib/ozon/error-product-repair";
import { handleRouteError, ok } from "@/lib/utils/route";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await inspectOzonErrorProducts());
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST() {
  try {
    return ok(startOzonErrorRepair(), { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
