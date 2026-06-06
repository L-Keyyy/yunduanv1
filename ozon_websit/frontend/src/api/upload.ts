import apiClient from './client'

export const fetchUploadJobs = async (storeId?: number, limit = 50) => {
  const response = await apiClient.get('/upload/jobs', {
    params: {
      store_id: storeId,
      limit,
    },
  })
  return response.data
}

export const fetchUploadJob = async (jobId: number) => {
  const response = await apiClient.get(`/upload/jobs/${jobId}`)
  return response.data
}

export const refreshUploadJob = async (jobId: number) => {
  const response = await apiClient.post(`/upload/jobs/${jobId}/refresh`)
  return response.data
}
