import { prisma } from "@/lib/db/prisma";
import { decryptSecret, encryptSecret } from "@/lib/utils/crypto";
import { env } from "@/lib/utils/env";

export type OzonConfigSource = "database" | "env" | "missing";

export type OzonConnectionState = {
  id: string | null;
  name: string;
  active: boolean;
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

const OZON_DRAFT_API_KEY = "__OZON_STORE_DRAFT__";

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
    active: ready,
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

function savedConnectionState(saved: {
  id: string;
  name: string;
  baseUrl: string;
  clientId: string;
  apiKeyEncrypted: string;
  isActive: boolean;
  updatedAt: Date;
}): OzonConnectionState {
  let apiKeyConfigured = true;
  let maskedApiKey = "已保存";
  try {
    const decrypted = decryptSecret(saved.apiKeyEncrypted);
    apiKeyConfigured = Boolean(
      decrypted.trim() && decrypted !== OZON_DRAFT_API_KEY,
    );
    maskedApiKey = apiKeyConfigured ? maskSecret(decrypted) : "";
  } catch {
    apiKeyConfigured = false;
    maskedApiKey = "";
  }

  return {
    id: saved.id,
    name: saved.name,
    active: saved.isActive,
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

export async function listOzonConnectionStates(): Promise<OzonConnectionState[]> {
  const saved = await prisma.ozonApiConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });
  if (saved.length) return saved.map(savedConnectionState);
  const fallback = envConnectionState();
  return fallback.ready ? [fallback] : [];
}

export async function getOzonConnectionState(): Promise<OzonConnectionState> {
  const stores = await listOzonConnectionStates();
  return stores.find((store) => store.active) ?? stores[0] ?? envConnectionState();
}

export async function getOzonCredentials(
  configId?: string | null,
): Promise<OzonCredentials | null> {
  const saved = configId
    ? await prisma.ozonApiConfig.findUnique({ where: { id: configId } })
    : await prisma.ozonApiConfig.findFirst({
        where: { isActive: true },
        orderBy: { updatedAt: "desc" },
      });

  if (saved) {
    const apiKey = decryptSecret(saved.apiKeyEncrypted);
    const clientId = saved.clientId.trim();
    if (!clientId || !apiKey || apiKey === OZON_DRAFT_API_KEY) return null;
    return {
      baseUrl: normalizeBaseUrl(saved.baseUrl),
      clientId,
      apiKey,
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
    const existingApiKey = decryptSecret(existing.apiKeyEncrypted);
    if (existingApiKey === OZON_DRAFT_API_KEY) {
      throw new Error("请填写 Ozon Api-Key。");
    }
    apiKeyEncrypted = existing.apiKeyEncrypted;
  } else {
    throw new Error("请填写 Ozon Api-Key。");
  }

  const saved = input.id
    ? await prisma.ozonApiConfig.update({
        where: { id: input.id },
        data: {
          name,
          baseUrl,
          clientId,
          apiKeyEncrypted,
        },
      })
    : await prisma.ozonApiConfig.create({
        data: {
          name,
          baseUrl,
          clientId,
          apiKeyEncrypted,
          isActive:
            (await prisma.ozonApiConfig.count({
              where: { isActive: true },
            })) === 0,
        },
      });

  return saved.id;
}

export async function createOzonApiConfigDraft(name?: string | null) {
  const count = await prisma.ozonApiConfig.count();
  return prisma.ozonApiConfig.create({
    data: {
      name: name?.trim() || `Ozon 店铺 ${count + 1}`,
      baseUrl: "https://api-seller.ozon.ru",
      clientId: "",
      apiKeyEncrypted: encryptSecret(OZON_DRAFT_API_KEY),
      isActive: false,
    },
  });
}

export async function activateOzonApiConfig(id: string) {
  const existing = await prisma.ozonApiConfig.findUnique({ where: { id } });
  if (!existing) throw new Error("店铺配置不存在。");
  await prisma.$transaction([
    prisma.ozonApiConfig.updateMany({ data: { isActive: false } }),
    prisma.ozonApiConfig.update({ where: { id }, data: { isActive: true } }),
  ]);
  return id;
}

export async function deleteOzonApiConfig(id: string) {
  const existing = await prisma.ozonApiConfig.findUnique({ where: { id } });
  if (!existing) throw new Error("店铺配置不存在。");
  await prisma.ozonApiConfig.delete({ where: { id } });
  if (existing.isActive) {
    const next = await prisma.ozonApiConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    if (next) {
      await prisma.ozonApiConfig.update({
        where: { id: next.id },
        data: { isActive: true },
      });
    }
  }
}
