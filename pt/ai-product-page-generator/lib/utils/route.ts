import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { apiError, apiSuccess } from "@/lib/utils/api";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(apiSuccess(data), init);
}

export function fail(code: string, message: string, details?: unknown, status = 400) {
  return NextResponse.json(apiError(code, message, details), { status });
}

function mapProviderError(error: Error) {
  const text = error.message.toLowerCase();

  if (/monthly spending limit|spending limit|insufficient_quota|resource_exhausted|quota|billing|prepayment credits are depleted|credits are depleted|额度已用尽|预付额度|月度限额/.test(text)) {
    return {
      code: "SPENDING_LIMIT_REACHED",
      message: "当前 API Key 的额度或预付费余额已用尽。请到对应模型服务控制台充值、提高额度，或更换可用的 API Key。",
      status: 403,
    };
  }

  if (/rate limit|429|限流/.test(text)) {
    return {
      code: "RATE_LIMITED",
      message: "当前请求触发了限流。请稍后重试，或降低调用频率。",
      status: 429,
    };
  }

  if (/user location is not supported|location is not supported|failed_precondition/.test(text)) {
    return {
      code: "PROVIDER_REGION_UNSUPPORTED",
      message: "当前代理出口地区不支持这个模型服务。请切换到支持 Gemini API 的代理节点，或先改用 DeepSeek 等可访问的文本模型。",
      status: 403,
    };
  }

  if (/invalid token|invalid api key|api key not valid|api_key_invalid|permission_denied|unauthorized|forbidden|鉴权失败|401|403/.test(text)) {
    return {
      code: "PROVIDER_AUTH_ERROR",
      message: "当前 Provider 鉴权失败。请检查 baseURL、API Key 或代理商权限配置。",
      status: 401,
    };
  }

  if (/timed out|aborterror|network error|fetch failed|请求超时|网络异常/.test(text)) {
    return {
      code: "PROVIDER_TIMEOUT",
      message: "当前 Provider 请求超时或网络异常，请稍后重试。",
      status: 504,
    };
  }

  return null;
}

export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    return fail("VALIDATION_ERROR", "请求参数校验失败", error.flatten(), 400);
  }

  if (error instanceof Error) {
    const providerError = mapProviderError(error);
    if (providerError) {
      return fail(providerError.code, providerError.message, { rawMessage: error.message }, providerError.status);
    }

    const message = error.message.toLowerCase();
    if (message.includes("not found")) {
      return fail("NOT_FOUND", error.message, null, 404);
    }

    return fail("INTERNAL_ERROR", error.message, null, 500);
  }

  return fail("UNKNOWN_ERROR", "未知错误", null, 500);
}
