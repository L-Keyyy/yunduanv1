import {
  createOzonApiConfigDraft,
  getOzonConnectionState,
  listOzonConnectionStates,
} from "@/lib/ozon/config-service";
import { NextRequest } from "next/server";
import { z } from "zod";
import { handleRouteError, ok } from "@/lib/utils/route";

export async function GET() {
  try {
    const stores = await listOzonConnectionStates();
    const active = await getOzonConnectionState();
    return ok({
      stores,
      activeStoreId: active.id,
      activeStoreName: active.name,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

const createDraftSchema = z.object({
  name: z.string().trim().max(200).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = createDraftSchema.parse(await request.json());
    const draft = await createOzonApiConfigDraft(input.name);
    const stores = await listOzonConnectionStates();
    return ok({
      draft: stores.find((store) => store.id === draft.id),
      stores,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
