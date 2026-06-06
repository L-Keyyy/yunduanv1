import apiClient from './client'

export const fetchNotifications = async (storeId?: number) => {
  const response = await apiClient.get('/notifications', {
    params: { store_id: storeId },
  })
  return response.data
}
