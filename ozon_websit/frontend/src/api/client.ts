import axios from 'axios'
import { clearAuthSession, getAuthToken } from '../utils/auth'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
})

apiClient.interceptors.request.use((config) => {
  const token = getAuthToken()
  if (token) {
    config.headers = config.headers || {}
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      clearAuthSession()
      const isAdminPath = window.location.pathname.startsWith('/admin')
      const loginPath = isAdminPath ? '/admin/login' : '/login'
      if (window.location.pathname !== loginPath) {
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `${loginPath}?redirect=${next}`
      }
    }
    return Promise.reject(error)
  }
)

export default apiClient
