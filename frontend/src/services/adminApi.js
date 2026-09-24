import api from '../utils/api'


export const getUsers = (params = {}) => {
    return api.get('/api/admin/users', { params })
}


export const updateUserStatus = (userId, isActive) => {
    return api.patch(`/api/admin/users/${userId}/status`, { is_active: isActive })
}


export const getStats = () => {
    return api.get('/api/admin/stats')
}


// Platform-wide analytics. Admin only — the server checks the role on the
// verified token, so this is a request the API is free to refuse.
export const getPlatformAnalytics = (range = {}) => {
    return api.get('/api/admin/analytics', { params: range })
}


// Rider feedback written by customers. Admin only — this is the single
// endpoint anywhere in the API that returns the contents of rider_reviews.
export const getRiderReviews = (params = {}) => {
    return api.get('/api/admin/rider-reviews', { params })
}
