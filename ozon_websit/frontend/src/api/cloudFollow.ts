import apiClient from './client'
import type { AsyncTaskSubmitResponse } from './jobs'

export interface CloudFollowPreviewPayload {
  reference: string
  use_browser_session?: boolean
  preferred_url_fragment?: string
  front_cookie?: string
  user_agent?: string
}

export interface CloudFollowPreviewResponse {
  ok: boolean
  reference: string
  resolved_product_id: number
  source_url: string
  fetch_source?: string
  page_url?: string
  title?: string
  variant_count: number
  characteristics_count: number
  has_description: boolean
  has_price: boolean
  product_data: Record<string, unknown>
}

export interface CloudFollowSubmitPayload extends CloudFollowPreviewPayload {
  store_id?: number
  include_variants?: boolean
  max_variants?: number
  price?: string | number
  old_price?: string | number
  follow_min_price?: string | number
  model?: string
}

export interface CloudFollowSubmitResponse {
  ok: boolean
  job_id: string
  status: string
  store_id: number
  item_count: number
  variant_mode: string
  resolved_product_id: number
  source_url: string
  fetch_source?: string
  skipped_variants: number
}

export interface CloudFollowCollectTaskItem {
  reference: string
  price?: string | number
  old_price?: string | number
  follow_min_price?: string | number
  model?: string
}

export interface CloudFollowCollectTaskCreatePayload {
  store_id?: number
  include_variants?: boolean
  max_variants?: number
  tasks: CloudFollowCollectTaskItem[]
}

export interface CloudFollowCollectTask {
  id: number
  tenant_id?: number | null
  user_owner: string
  store_id: number
  reference: string
  resolved_product_id?: string | null
  status: string
  include_variants: boolean
  max_variants: number
  price?: string | null
  old_price?: string | null
  follow_min_price?: string | null
  model?: string | null
  source_url?: string | null
  error?: string | null
  upload_job_id?: number | null
  claimed_at?: string | null
  completed_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface CloudFollowCollectTaskListResponse {
  ok: boolean
  result: CloudFollowCollectTask[]
}

export interface CloudFollowConfig {
  front_cookie?: string | null
  user_agent?: string | null
  updated_at?: string | null
}

export const fetchCloudFollowConfig = async (): Promise<CloudFollowConfig> => {
  const response = await apiClient.get('/cloud-follow/config')
  return response.data as CloudFollowConfig
}

export const saveCloudFollowConfig = async (
  payload: CloudFollowConfig,
): Promise<CloudFollowConfig> => {
  const response = await apiClient.put('/cloud-follow/config', payload)
  return response.data as CloudFollowConfig
}

export const createCloudFollowCollectTasks = async (
  payload: CloudFollowCollectTaskCreatePayload,
): Promise<CloudFollowCollectTaskListResponse> => {
  const response = await apiClient.post('/cloud-follow/collect-tasks', payload, {
    timeout: 45000,
  })
  return response.data as CloudFollowCollectTaskListResponse
}

export const fetchCloudFollowCollectTasks = async (params?: {
  status?: string
  store_id?: number
  limit?: number
}): Promise<CloudFollowCollectTaskListResponse> => {
  const response = await apiClient.get('/cloud-follow/collect-tasks', { params })
  return response.data as CloudFollowCollectTaskListResponse
}

export const previewCloudFollow = async (
  payload: CloudFollowPreviewPayload,
): Promise<CloudFollowPreviewResponse> => {
  const response = await apiClient.post('/cloud-follow/preview', payload, {
    timeout: 60000,
  })
  return response.data as CloudFollowPreviewResponse
}

export const submitCloudFollow = async (
  payload: CloudFollowSubmitPayload,
): Promise<CloudFollowSubmitResponse> => {
  const response = await apiClient.post('/cloud-follow/submit', payload, {
    timeout: 180000,
  })
  return response.data as CloudFollowSubmitResponse
}

export const submitCloudFollowAsync = async (
  payload: CloudFollowSubmitPayload,
): Promise<AsyncTaskSubmitResponse> => {
  const response = await apiClient.post('/cloud-follow/submit-async', payload, {
    timeout: 45000,
  })
  return response.data as AsyncTaskSubmitResponse
}
