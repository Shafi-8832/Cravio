import api from '../utils/api'
export const getRiderProfile = () => api.get('/api/rider/profile')
export const updateRiderProfile = payload => api.patch('/api/rider/profile', payload)


export const getAvailableDeliveries = (params = {}) => {
    return api.get('/api/rider/deliveries/available', { params })
}


export const getMyDeliveries = () => {
    return api.get('/api/rider/deliveries/mine')
}


export const acceptDelivery = (orderId) => {
    return api.post(`/api/rider/deliveries/${orderId}/accept`)
}


export const updateDeliveryStatus = (orderId, status) => {
    return api.patch(`/api/rider/deliveries/${orderId}/status`, { status })
}
