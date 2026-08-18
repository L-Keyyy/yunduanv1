import { NextRequest } from "next/server";
import { z } from "zod";

import { getOzonConnectionState } from "@/lib/ozon/client";
import {
  listOzonConnectionStates,
  saveOzonApiConfig,
} from "@/lib/ozon/config-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const ozonConfigSchema = z.object({
  id: z.string().optional().nullable(),
  name: z.string().trim().optional().default("Ozon Seller API"),
  baseUrl: z.string().trim().url("请输入有效的 Ozon API 地址"),
  clientId: z.string().trim().min(1, "请填写 Client-Id"),
  apiKey: z.string().trim().optional().default(""),
});

export async function GET() {
  try {
    return ok(await getOzonConnectionState());
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = ozonConfigSchema.parse(await request.json());
    const savedConfigId = await saveOzonApiConfig(parsed);
    const connection = await getOzonConnectionState();
    const savedStore = (await listOzonConnectionStates()).find(
      (store) => store.id === savedConfigId,
    );
    return ok({
      savedConfigId,
      connection,
      savedStore,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
