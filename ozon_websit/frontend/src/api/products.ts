import apiClient from './client'

export const fetchProducts = async (params: Record<string, any>) => {
  const response = await apiClient.get('/products', { params })
  return response.data
}

export const fetchProductFilters = async (storeId?: number) => {
  const response = await apiClient.get('/products/filters', {
    params: {
      store_id: storeId,
    },
  })
  return response.data
}

export const fetchProductMarketInsights = async (productId: number, period = 'weekly') => {
  const response = await apiClient.get(`/products/${productId}/market-insights`, {
    params: {
      period,
    },
  })
  return response.data
}

export const syncProducts = async () => {
  const response = await apiClient.post('/products/sync')
  return response.data
}

export const batchUpdateProductPrice = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/price', payload)
  return response.data
}

export const batchUpdateProductStock = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/stock', payload)
  return response.data
}

export const batchArchiveProducts = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/archive', payload)
  return response.data
}

export const batchRemarkProducts = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/remark', payload)
  return response.data
}

export const batchRetryProducts = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/retry', payload)
  return response.data
}

export const fetchInventory = async (params: Record<string, any>) => {
  const response = await apiClient.get('/inventory', { params })
  return response.data
}

export const batchBackupInventory = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/backup', payload)
  return response.data
}

export const batchRestoreInventory = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/restore', payload)
  return response.data
}

export const batchUpdateInventoryStock = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/update-stock', payload)
  return response.data
}

export const batchUpdateInventoryAutomation = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/automation', payload)
  return response.data
}
