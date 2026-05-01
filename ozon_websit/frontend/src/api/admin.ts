import apiClient from './client'

export interface AdminOverview {
  tenants: number
  users: number
  stores: number
  products: number
  orders: number
  active_subscriptions: number
}

export interface AdminTenant {
  id: number
  name: string
  slug: string
  status: string
  plan_code: string
  subscription_status: string
  store_limit: number
  user_limit: number
  expires_at?: string | null
  created_at?: string | null
  stores_count: number
  users_count: number
  max_daily_create?: number | null
  max_daily_update?: number | null
  max_total_products?: number | null
}

export interface AdminTenantPayload {
  name?: string
  slug?: string
  status?: string
  plan_code?: string
  subscription_status?: string
  store_limit?: number
  user_limit?: number
  expires_at?: string | null
  max_daily_create?: number
  max_daily_update?: number
  max_total_products?: number
}

export interface AdminUser {
  id: number
  username: string
  display_name: string
  email?: string | null
  is_active: boolean
  is_admin: boolean
  primary_tenant_id?: number | null
  tenant_name?: string | null
  roles: string[]
  created_at?: string | null
  last_login_at?: string | null
}

export interface AdminUserCreatePayload {
  username: string
  password: string
  display_name?: string
  email?: string
  tenant_id: number
  is_active?: boolean
  roles?: string[]
}

export interface AdminUserUpdatePayload {
  display_name?: string
  email?: string | null
  password?: string
  tenant_id?: number
  is_active?: boolean
  roles?: string[]
}

export interface AdminRole {
  id: number
  tenant_id?: number | null
  code: string
  name: string
  scope: string
  is_system: boolean
}

export interface AdminPermission {
  id: number
  code: string
  name: string
  group?: string | null
  description?: string | null
}

export interface AdminMenu {
  id: number
  code: string
  title: string
  path?: string | null
  parent_code?: string | null
  sort_order: number
  required_permission?: string | null
  is_admin: boolean
  is_active: boolean
}

export interface AdminAuditLog {
  id: number
  tenant_id?: number | null
  user_id?: number | null
  actor_username?: string | null
  action: string
  resource_type?: string | null
  resource_id?: string | null
  details?: string | null
  ip_address?: string | null
  user_agent?: string | null
  created_at?: string | null
}

export interface AdminLoginLog {
  id: number
  tenant_id?: number | null
  user_id?: number | null
  username: string
  role_scope?: string | null
  success: boolean
  ip_address?: string | null
  user_agent?: string | null
  failure_reason?: string | null
  created_at?: string | null
}

export interface AdminCacheStatus {
  activity_query_entries: number
  activity_product_detail_entries: number
  seller_market_trends_entries: number
  seller_market_all_roots_entries: number
  seller_hot_tags_entries: number
  seller_product_market_entries: number
}

export interface AdminSyncSchedule {
  id: number
  tenant_id: number
  tenant_name?: string | null
  store_id?: number | null
  store_name?: string | null
  name: string
  job_type: string
  enabled: boolean
  interval_minutes: number
  days: number
  last_run_at?: string | null
  next_run_at?: string | null
  last_status?: string | null
  last_message?: string | null
  last_task_id?: string | null
  locked_until?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface AdminSyncSchedulePayload {
  tenant_id?: number
  store_id?: number | null
  name?: string
  job_type?: string
  enabled?: boolean
  interval_minutes?: number
  days?: number
  next_run_at?: string | null
}

export interface AdminSyncRun {
  id: number
  tenant_id: number
  tenant_name?: string | null
  schedule_id?: number | null
  store_id?: number | null
  store_name?: string | null
  job_type: string
  status: string
  triggered_by: string
  task_id?: string | null
  started_at?: string | null
  finished_at?: string | null
  result_payload?: Record<string, unknown> | null
  error?: string | null
  created_at?: string | null
}

export interface AdminAsyncTask {
  message: string
  mode: string
  task_id: string
  task_name: string
  status: string
}

export async function fetchAdminOverview() {
  const { data } = await apiClient.get<AdminOverview>('/admin/overview')
  return data
}

export async function fetchAdminTenants() {
  const { data } = await apiClient.get<AdminTenant[]>('/admin/tenants')
  return data
}

export async function createAdminTenant(payload: AdminTenantPayload) {
  const { data } = await apiClient.post<AdminTenant>('/admin/tenants', payload)
  return data
}

export async function updateAdminTenant(id: number, payload: AdminTenantPayload) {
  const { data } = await apiClient.put<AdminTenant>(`/admin/tenants/${id}`, payload)
  return data
}

export async function fetchAdminUsers(params?: { tenant_id?: number; search?: string }) {
  const { data } = await apiClient.get<AdminUser[]>('/admin/users', { params })
  return data
}

export async function createAdminUser(payload: AdminUserCreatePayload) {
  const { data } = await apiClient.post<AdminUser>('/admin/users', payload)
  return data
}

export async function updateAdminUser(id: number, payload: AdminUserUpdatePayload) {
  const { data } = await apiClient.put<AdminUser>(`/admin/users/${id}`, payload)
  return data
}

export async function fetchAdminRoles() {
  const { data } = await apiClient.get<AdminRole[]>('/admin/roles')
  return data
}

export async function fetchAdminPermissions() {
  const { data } = await apiClient.get<AdminPermission[]>('/admin/permissions')
  return data
}

export async function fetchAdminMenus() {
  const { data } = await apiClient.get<AdminMenu[]>('/admin/menus')
  return data
}

export async function fetchAdminAuditLogs(limit = 100) {
  const { data } = await apiClient.get<AdminAuditLog[]>('/admin/audit-logs', {
    params: { limit },
  })
  return data
}

export async function fetchAdminLoginLogs(limit = 100) {
  const { data } = await apiClient.get<AdminLoginLog[]>('/admin/login-logs', {
    params: { limit },
  })
  return data
}

export async function fetchAdminCacheStatus() {
  const { data } = await apiClient.get<AdminCacheStatus>('/admin/cache/status')
  return data
}

export async function clearAdminCache(scope = 'all') {
  const { data } = await apiClient.post<AdminCacheStatus & { cleared_scope: string }>(
    '/admin/cache/clear',
    { scope },
  )
  return data
}

export async function fetchAdminSyncSchedules(params?: { tenant_id?: number; enabled?: boolean }) {
  const { data } = await apiClient.get<AdminSyncSchedule[]>('/admin/sync-schedules', {
    params,
  })
  return data
}

export async function createAdminSyncSchedule(payload: AdminSyncSchedulePayload) {
  const { data } = await apiClient.post<AdminSyncSchedule>('/admin/sync-schedules', payload)
  return data
}

export async function updateAdminSyncSchedule(id: number, payload: AdminSyncSchedulePayload) {
  const { data } = await apiClient.put<AdminSyncSchedule>(`/admin/sync-schedules/${id}`, payload)
  return data
}

export async function runAdminSyncSchedule(id: number) {
  const { data } = await apiClient.post<AdminAsyncTask>(`/admin/sync-schedules/${id}/run`)
  return data
}

export async function fetchAdminSyncRuns(params?: {
  tenant_id?: number
  schedule_id?: number
  limit?: number
}) {
  const { data } = await apiClient.get<AdminSyncRun[]>('/admin/sync-runs', { params })
  return data
}
