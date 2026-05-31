import apiClient from './client'
import { clearResourceCache, readResourceCache, writeResourceCache } from '../utils/resourceCache'

const ORDER_LIST_CACHE_SCOPE = 'orders:list'

type OrderFetchOptions = {
  forceRefresh?: boolean
}

export const markOrderDataDirty = () => {
  clearResourceCache(ORDER_LIST_CACHE_SCOPE)
}

export const fetchOrders = async (
  params: Record<string, any>,
  options: OrderFetchOptions = {},
) => {
  const cacheParts = [params || {}]
  if (!options.forceRefresh) {
    const cached = readResourceCache<any>(ORDER_LIST_CACHE_SCOPE, cacheParts)
    if (cached) {
      return cached.data
    }
  }

  const response = await apiClient.get('/orders', { params })
  writeResourceCache(ORDER_LIST_CACHE_SCOPE, cacheParts, response.data)
  return response.data
}

export const syncOrders = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/orders/sync', payload)
  markOrderDataDirty()
  return response.data
}

export const markOrderPackaged = async (orderId: number) => {
  const response = await apiClient.post(`/orders/${orderId}/mark-packaged`)
  markOrderDataDirty()
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
  markOrderDataDirty()
  return response.data
}

export const markOrderPrinted = async (orderId: number) => {
  return batchWarehousePrint({ ids: [orderId] })
}

export const downloadOrderWaybillPdf = async (orderId: number) => {
  const response = await apiClient.post(`/orders/${orderId}/waybill-pdf`, undefined, {
    responseType: 'blob',
    timeout: 60000,
  })
  return response
}

export const batchWarehouseDownload = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/warehouse/batch/download', payload)
  markOrderDataDirty()
  return response.data
}

export const batchWarehouseClose = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/warehouse/batch/close', payload)
  markOrderDataDirty()
  return response.data
}
