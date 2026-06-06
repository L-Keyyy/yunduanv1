import apiClient from './client'

export interface DashboardSummary {
  today_orders: number
  pending_fbs_orders: number
  total_products: number
  low_stock_alerts: number
  active_stores: number
  submitted_jobs: number
  completed_jobs: number
  failed_jobs: number
  successful_uploaded_skus: number
}

export interface DashboardTrends {
  labels: string[]
  uploads: number[]
  completed: number[]
  successful_uploaded_skus: number[]
  orders: number[]
  revenue: number[]
  sales_units: number[]
}

export interface HealthSection {
  status: string
  detail?: string
  [key: string]: any
}

export interface ApiHealthResponse {
  status: string
  service: string
  environment: string
  started_at: string
  api_prefix: string
  database: HealthSection
  browser_assist?: HealthSection
}

export const fetchDashboardSummary = async (storeId?: number) => {
  const response = await apiClient.get('/dashboard/summary', {
    params: { store_id: storeId },
  })
  return response.data as DashboardSummary
}

export const fetchDashboardTrends = async (days = 7, storeId?: number) => {
  const response = await apiClient.get('/dashboard/trends', {
    params: { days, store_id: storeId },
  })
  return response.data as DashboardTrends
}

export const fetchApiHealth = async () => {
  const response = await apiClient.get('/health')
  return response.data as ApiHealthResponse
}
