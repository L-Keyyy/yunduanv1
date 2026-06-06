import apiClient from './client'

export type AsyncTaskStatus =
  | 'PENDING'
  | 'STARTED'
  | 'SUCCESS'
  | 'FAILURE'
  | 'RETRY'
  | 'REVOKED'
  | string

export interface AsyncTaskSubmitResponse {
  task_id: string
  task_name: string
  status: AsyncTaskStatus
  message?: string
}

export interface AsyncTaskStatusResponse {
  task_id: string
  task_name?: string
  status: AsyncTaskStatus
  ready: boolean
  successful: boolean
  failed: boolean
  result?: any
  error?: string | null
}

export interface StoreScopedTaskRequest {
  store_id?: number
}

export interface OrderSyncTaskRequest extends StoreScopedTaskRequest {
  days?: number
}

export const submitVerifyStoresJob = async (payload: StoreScopedTaskRequest = {}) => {
  const response = await apiClient.post('/jobs/verify-stores', payload)
  return response.data as AsyncTaskSubmitResponse
}

export const submitSyncProductsJob = async (payload: StoreScopedTaskRequest = {}) => {
  const response = await apiClient.post('/jobs/sync-products', payload)
  return response.data as AsyncTaskSubmitResponse
}

export const submitSyncOrdersJob = async (payload: OrderSyncTaskRequest = {}) => {
  const response = await apiClient.post('/jobs/sync-orders', payload)
  return response.data as AsyncTaskSubmitResponse
}

export const submitSyncBrowserWarehousesJob = async (storeId: number) => {
  const response = await apiClient.post('/jobs/sync-browser-warehouses', { store_id: storeId })
  return response.data as AsyncTaskSubmitResponse
}

export const submitSyncCoreJob = async (payload: OrderSyncTaskRequest = {}) => {
  const response = await apiClient.post('/jobs/sync-core', payload)
  return response.data as AsyncTaskSubmitResponse
}

export const fetchJobStatus = async (taskId: string) => {
  const response = await apiClient.get(`/jobs/${taskId}`)
  return response.data as AsyncTaskStatusResponse
}
