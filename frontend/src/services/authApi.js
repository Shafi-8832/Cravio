import api from '../utils/api'
export const signIn = payload => api.post('/api/auth/login', payload)
export const signUp = payload => api.post('/api/auth/signup', payload)
export const signOut = () => api.post('/api/auth/logout')
// OTP verification after signup. Both are public: the account has no token yet.
export const verifyOtp = payload => api.post('/api/auth/verify-otp', payload)
export const resendOtp = payload => api.post('/api/auth/resend-otp', payload)
