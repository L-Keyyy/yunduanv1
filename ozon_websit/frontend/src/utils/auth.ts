import type { AuthUser } from '../api/auth'

const AUTH_TOKEN_KEY = 'ozon_access_token'
const AUTH_USERNAME_KEY = 'ozon_username'
const AUTH_USER_KEY = 'ozon_auth_user'
const STORE_CACHE_PREFIX = 'ozon_store_list_cache:'
const STORE_DIRTY_PREFIX = 'ozon_store_list_dirty:'
const PRODUCT_CACHE_PREFIX = 'ozon_product_list_cache:'
const PRODUCT_FILTER_PREFIX = 'ozon_product_filter_cache:'
const PRODUCT_DIRTY_PREFIX = 'ozon_product_cache_dirty:'
const INVENTORY_CACHE_PREFIX = 'ozon_inventory_list_cache:'
const INVENTORY_DIRTY_PREFIX = 'ozon_inventory_cache_dirty:'
const MESSAGES_CACHE_PREFIX = 'ozon_messages_list_cache:'
const MESSAGES_FETCH_AT_PREFIX = 'ozon_messages_last_fetch_at:'
const ACTIVITIES_AUTO_REFRESH_AT_PREFIX = 'ozon_activities_auto_refresh_at:'
const RESOURCE_CACHE_PREFIX = 'ozon_resource_cache:'
export const AUTH_SESSION_EVENT = 'auth-session-changed'

function emitAuthSessionChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_EVENT))
  }
}

function clearStoreCaches(): void {
  if (typeof window === 'undefined') return
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i)
    if (
      key &&
      (key.startsWith(STORE_CACHE_PREFIX) ||
        key.startsWith(STORE_DIRTY_PREFIX) ||
        key.startsWith(PRODUCT_CACHE_PREFIX) ||
        key.startsWith(PRODUCT_FILTER_PREFIX) ||
        key.startsWith(PRODUCT_DIRTY_PREFIX) ||
        key.startsWith(INVENTORY_CACHE_PREFIX) ||
        key.startsWith(INVENTORY_DIRTY_PREFIX) ||
        key.startsWith(MESSAGES_CACHE_PREFIX) ||
        key.startsWith(MESSAGES_FETCH_AT_PREFIX) ||
        key.startsWith(ACTIVITIES_AUTO_REFRESH_AT_PREFIX) ||
        key.startsWith(RESOURCE_CACHE_PREFIX))
    ) {
      localStorage.removeItem(key)
    }
  }
}

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY)
}

export function getAuthUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_USER_KEY)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    return null
  }
}

export function getAuthUsername(): string | null {
  const user = getAuthUser()
  if (user?.display_name) {
    return user.display_name
  }
  if (user?.username) {
    return user.username
  }
  return localStorage.getItem(AUTH_USERNAME_KEY)
}

export function isAuthenticated(): boolean {
  return Boolean(getAuthToken())
}

export function isAdminAuthenticated(): boolean {
  const user = getAuthUser()
  return Boolean(user?.is_super_admin || user?.is_admin || user?.roles?.includes('super_admin'))
}

export function setAuthSession(token: string, user: AuthUser): void {
  clearStoreCaches()
  localStorage.setItem(AUTH_TOKEN_KEY, token)
  localStorage.setItem(AUTH_USERNAME_KEY, user.username)
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
  emitAuthSessionChange()
}

export function clearAuthSession(): void {
  clearStoreCaches()
  localStorage.removeItem(AUTH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USERNAME_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
  emitAuthSessionChange()
}
