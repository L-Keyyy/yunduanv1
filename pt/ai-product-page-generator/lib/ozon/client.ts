import {
  getOzonConnectionState as readOzonConnectionState,
  getOzonCredentials,
  type OzonConnectionState,
} from "@/lib/ozon/config-service";

export class OzonConfigError extends Error {
  constructor(message = "请先在 .env 中配置 OZON_CLIENT_ID 和 OZON_API_KEY。") {
    super(message);
    this.name = "OzonConfigError";
  }
}

export type { OzonConnectionState };

export async function getOzonConnectionState(): Promise<OzonConnectionState> {
  return readOzonConnectionState();
}

async function requireOzonCredentials() {
  const credentials = await getOzonCredentials();
  if (!credentials) {
    throw new OzonConfigError();
  }
  return credentials;
}

function readOzonError(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const message = record.message ?? record.error ?? record.details;
  if (typeof message === "string") return message;
  return null;
}

export async function ozonSellerRequest<TResponse>(
  endpoint: string,
  body: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
) {
  const credentials = await requireOzonCredentials();
  const response = await fetch(`${credentials.baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Client-Id": credentials.clientId,
      "Api-Key": credentials.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const ozonMessage = readOzonError(payload);
    throw new Error(`Ozon Seller API ${response.status}: ${ozonMessage ?? text}`);
  }

  return payload as TResponse;
}
