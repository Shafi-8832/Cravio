import axios from 'axios'

// The one place the backend address is decided. Set VITE_API_URL per
// environment (frontend/.env locally, Vercel project settings in
// production); vite.config.js refuses a Vercel build without it.
// A trailing slash is removed so `API_URL + '/api/...'` never doubles it.
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '')

// 60 s rather than 15 s: a free Render instance sleeps when idle and needs
// up to about a minute to wake, and the first request must survive that.
const api = axios.create({ baseURL: API_URL, timeout: 60000 })
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = 'Bearer ' + token
  return config
})
api.interceptors.response.use(response => response, error => {
  // Invalid credentials render inline; an expired existing session is cleared.
  const authRequest = /\/api\/auth\/(login|signup|verify-otp|resend-otp)/.test(error.config?.url || '')
  if (error.response?.status === 401 && !authRequest && localStorage.getItem('token')) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.dispatchEvent(new Event('cravio:session-ended'))
  }
  return Promise.reject(error)
})
export default api
