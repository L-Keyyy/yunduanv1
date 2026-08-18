import { z } from "zod";

import { uploadListingWorkflowImagesToOzon } from "@/lib/ozon/image-upload";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  listingWorkflowItemId: z.string().trim().min(1).optional(),
  offerId: z.string().trim().min(1).optional(),
  productId: z.union([z.number().int().positive(), z.string().trim().min(1)]).nullable().optional(),
  imageUrls: z.array(z.string().url()).min(1).max(30).optional(),
}).refine(
  (input) => Boolean(input.listingWorkflowItemId || input.offerId || input.productId),
  "至少需要 listingWorkflowItemId、offerId 或 productId 中的一项",
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    return ok(await uploadListingWorkflowImagesToOzon(input));
  } catch (error) {
    return handleRouteError(error);
  }
}
