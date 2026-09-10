import api from '../utils/api'
export const signIn = payload => api.post('/api/auth/login', payload)
export const signUp = payload => api.post('/api/auth/signup', payload)
export const signOut = () => api.post('/api/auth/logout')
