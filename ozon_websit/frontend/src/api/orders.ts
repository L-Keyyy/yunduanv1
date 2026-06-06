import apiClient from './client'

export const fetchOrders = async (params: Record<string, any>) => {
  const response = await apiClient.get('/orders', { params })
  return response.data
}

export const syncOrders = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/orders/sync', payload)
  return response.data
}

export const markOrderPackaged = async (orderId: number) => {
  const response = await apiClient.post(`/orders/${orderId}/mark-packaged`)
  return response.data
}

export const fetchWarehouseOrders = async (params: Record<string, any>) => {
  const response = await apiClient.get('/warehouse/orders', { params })
  return response.data
}

export const batchWarehouseInbound = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/warehouse/batch/inbound', payload)
  return response.data
}

export const batchWarehousePrint = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/warehouse/batch/print', payload)
  return response.data
}

export const batchWarehouseDownload = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/warehouse/batch/download', payload)
  return response.data
}

export const batchWarehouseClose = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/warehouse/batch/close', payload)
  return response.data
}
