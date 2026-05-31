import apiClient from './client'
import { markStoreDataDirty } from './store'
import { markInventoryDataDirty, markProductDataDirty } from './products'

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

export const createCloudFollowCollectTasks = async (
  payload: CloudFollowCollectTaskCreatePayload,
): Promise<CloudFollowCollectTaskListResponse> => {
  const response = await apiClient.post('/cloud-follow/collect-tasks', payload, {
    timeout: 45000,
  })
  markStoreDataDirty()
  markProductDataDirty()
  markInventoryDataDirty()
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
