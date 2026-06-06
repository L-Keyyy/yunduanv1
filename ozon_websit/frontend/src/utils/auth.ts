import type { AuthUser } from '../api/auth'

const AUTH_TOKEN_KEY = 'ozon_access_token'
const AUTH_USERNAME_KEY = 'ozon_username'
const AUTH_USER_KEY = 'ozon_auth_user'
export const AUTH_SESSION_EVENT = 'auth-session-changed'

function emitAuthSessionChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_EVENT))
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
  localStorage.setItem(AUTH_TOKEN_KEY, token)
  localStorage.setItem(AUTH_USERNAME_KEY, user.username)
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
  emitAuthSessionChange()
}

export function clearAuthSession(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USERNAME_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
  emitAuthSessionChange()
}
