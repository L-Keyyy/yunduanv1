import { NextRequest } from "next/server";
import { z } from "zod";

import {
  activateOzonApiConfig,
  deleteOzonApiConfig,
  getOzonConnectionState,
  listOzonConnectionStates,
} from "@/lib/ozon/config-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const actionSchema = z.object({
  action: z.literal("activate"),
});

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    actionSchema.parse(await request.json());
    await activateOzonApiConfig(context.params.id);
    return ok({
      connection: await getOzonConnectionState(),
      stores: await listOzonConnectionStates(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    await deleteOzonApiConfig(context.params.id);
    return ok({
      connection: await getOzonConnectionState(),
      stores: await listOzonConnectionStates(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
