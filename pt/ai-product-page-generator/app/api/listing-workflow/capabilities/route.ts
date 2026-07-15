import { scanListingWorkflowCapabilities } from "@/lib/listing-workflow/capabilities";
import { handleRouteError, ok } from "@/lib/utils/route";

export async function GET() {
  try {
    const result = await scanListingWorkflowCapabilities();
    return ok(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
