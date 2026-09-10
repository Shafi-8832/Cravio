import axios from 'axios'

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000', timeout: 15000 })
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = 'Bearer ' + token
  return config
})
api.interceptors.response.use(response => response, error => {
  // Invalid credentials render inline; an expired existing session is cleared.
  const authRequest = /\/api\/auth\/(login|signup)/.test(error.config?.url || '')
  if (error.response?.status === 401 && !authRequest && localStorage.getItem('token')) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.dispatchEvent(new Event('cravio:session-ended'))
  }
  return Promise.reject(error)
})
export default api
