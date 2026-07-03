import { prisma } from "@/lib/db/prisma";
import { decryptSecret, encryptSecret } from "@/lib/utils/crypto";
import { env } from "@/lib/utils/env";

export type OzonConfigSource = "database" | "env" | "missing";

export type OzonConnectionState = {
  id: string | null;
  name: string;
  baseUrl: string;
  clientId: string;
  source: OzonConfigSource;
  clientIdConfigured: boolean;
  apiKeyConfigured: boolean;
  ready: boolean;
  maskedClientId: string;
  maskedApiKey: string;
  updatedAt: string | null;
};

export type OzonCredentials = {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  source: Exclude<OzonConfigSource, "missing">;
};

export type SaveOzonApiConfigInput = {
  id?: string | null;
  name: string;
  baseUrl: string;
  clientId: string;
  apiKey?: string | null;
};

function maskSecret(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function envConnectionState(): OzonConnectionState {
  const clientId = env.OZON_CLIENT_ID?.trim() ?? "";
  const apiKey = env.OZON_API_KEY?.trim() ?? "";
  const baseUrl = normalizeBaseUrl(env.OZON_API_BASE_URL);
  const ready = Boolean(clientId && apiKey);

  return {
    id: null,
    name: ready ? ".env Ozon Seller API" : "未配置",
    baseUrl,
    clientId,
    source: ready ? "env" : "missing",
    clientIdConfigured: Boolean(clientId),
    apiKeyConfigured: Boolean(apiKey),
    ready,
    maskedClientId: maskSecret(clientId),
    maskedApiKey: maskSecret(apiKey),
    updatedAt: null,
  };
}

export async function getOzonConnectionState(): Promise<OzonConnectionState> {
  const saved = await prisma.ozonApiConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!saved) {
    return envConnectionState();
  }

  let apiKeyConfigured = true;
  let maskedApiKey = "已保存";
  try {
    maskedApiKey = maskSecret(decryptSecret(saved.apiKeyEncrypted));
  } catch {
    apiKeyConfigured = false;
    maskedApiKey = "";
  }

  return {
    id: saved.id,
    name: saved.name,
    baseUrl: normalizeBaseUrl(saved.baseUrl),
    clientId: saved.clientId,
    source: "database",
    clientIdConfigured: Boolean(saved.clientId.trim()),
    apiKeyConfigured,
    ready: Boolean(saved.clientId.trim() && apiKeyConfigured),
    maskedClientId: maskSecret(saved.clientId),
    maskedApiKey,
    updatedAt: saved.updatedAt.toISOString(),
  };
}

export async function getOzonCredentials(): Promise<OzonCredentials | null> {
  const saved = await prisma.ozonApiConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  if (saved) {
    return {
      baseUrl: normalizeBaseUrl(saved.baseUrl),
      clientId: saved.clientId.trim(),
      apiKey: decryptSecret(saved.apiKeyEncrypted),
      source: "database",
    };
  }

  const clientId = env.OZON_CLIENT_ID?.trim() ?? "";
  const apiKey = env.OZON_API_KEY?.trim() ?? "";
  if (!clientId || !apiKey) return null;

  return {
    baseUrl: normalizeBaseUrl(env.OZON_API_BASE_URL),
    clientId,
    apiKey,
    source: "env",
  };
}

export async function saveOzonApiConfig(input: SaveOzonApiConfigInput) {
  const name = input.name.trim() || "Ozon Seller API";
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const clientId = input.clientId.trim();
  const apiKey = input.apiKey?.trim() ?? "";

  let apiKeyEncrypted: string;
  if (apiKey.length >= 6) {
    apiKeyEncrypted = encryptSecret(apiKey);
  } else if (input.id) {
    const existing = await prisma.ozonApiConfig.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw new Error("未找到可复用的 Ozon API 配置，请重新输入 Api-Key。");
    }
    apiKeyEncrypted = existing.apiKeyEncrypted;
  } else {
    throw new Error("请填写 Ozon Api-Key。");
  }

  await prisma.ozonApiConfig.updateMany({
    data: { isActive: false },
  });

  const saved = input.id
    ? await prisma.ozonApiConfig.update({
        where: { id: input.id },
        data: {
          name,
          baseUrl,
          clientId,
          apiKeyEncrypted,
          isActive: true,
        },
      })
    : await prisma.ozonApiConfig.create({
        data: {
          name,
          baseUrl,
          clientId,
          apiKeyEncrypted,
          isActive: true,
        },
      });

  return saved.id;
}
