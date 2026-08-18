import { readProcessingFifoStatus } from "@/lib/listing-workflow/processing-fifo";
import { handleRouteError, ok } from "@/lib/utils/route";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await readProcessingFifoStatus());
  } catch (error) {
    return handleRouteError(error);
  }
}
