import apiClient from './client'

export interface LoginPayload {
  username: string
  password: string
}

export interface RegisterPayload {
  username: string
  password: string
  display_name?: string
  email?: string
}

export interface AuthUser {
  id: number
  username: string
  display_name: string
  email?: string | null
  is_admin: boolean
  is_super_admin: boolean
  is_tenant_admin: boolean
  is_active: boolean
  tenant_id?: number | null
  tenant_name?: string | null
  roles: string[]
}

export interface LoginResponse {
  access_token: string
  token_type: string
  user: AuthUser
}

export async function login(payload: LoginPayload) {
  const { data } = await apiClient.post<LoginResponse>('/auth/login', payload)
  return data
}

export async function register(payload: RegisterPayload) {
  const { data } = await apiClient.post<LoginResponse>('/auth/register', payload)
  return data
}

export async function fetchCurrentUser() {
  const { data } = await apiClient.get<AuthUser>('/auth/me')
  return data
}
