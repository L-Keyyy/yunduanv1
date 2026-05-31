import { getAuthUser } from './auth'

export const RESOURCE_CACHE_TTL = {
  dashboard: 3 * 60 * 60 * 1000,
  orders: 60 * 60 * 1000,
  messages: 60 * 60 * 1000,
  activities: 24 * 60 * 60 * 1000,
  staticData: 30 * 24 * 60 * 60 * 1000,
}

export type CachedResource<T> = {
  updatedAt: number
  data: T
}

const RESOURCE_CACHE_PREFIX = 'ozon_resource_cache:v1:'

const ownerKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return username || 'anonymous'
}

const stablePart = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value !== 'object') {
    return String(value)
  }
  try {
    return JSON.stringify(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, item == null ? '' : item]),
    )
  } catch {
    return String(value)
  }
}

export const resolveResourceCacheKey = (scope: string, parts: unknown[] = []) =>
  `${RESOURCE_CACHE_PREFIX}${ownerKey()}:${scope}:${parts.map(stablePart).join(':')}`

export const readResourceCache = <T>(scope: string, parts: unknown[] = []): CachedResource<T> | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(resolveResourceCacheKey(scope, parts))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const updatedAt = Number(parsed.updatedAt || 0)
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
    return {
      updatedAt,
      data: parsed.data as T,
    }
  } catch {
    return null
  }
}

export const writeResourceCache = <T>(scope: string, parts: unknown[], data: T) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      resolveResourceCacheKey(scope, parts),
      JSON.stringify({
        updatedAt: Date.now(),
        data,
      }),
    )
  } catch {
    // ignore quota failures
  }
}

export const clearResourceCache = (scope: string) => {
  if (typeof window === 'undefined') return
  const prefix = `${RESOURCE_CACHE_PREFIX}${ownerKey()}:${scope}:`
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(prefix)) {
      localStorage.removeItem(key)
    }
  }
}

export const isResourceFresh = <T>(cached: CachedResource<T> | null, ttlMs: number) =>
  Boolean(cached && Date.now() - cached.updatedAt < ttlMs)
