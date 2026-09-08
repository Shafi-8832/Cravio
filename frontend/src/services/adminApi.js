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
