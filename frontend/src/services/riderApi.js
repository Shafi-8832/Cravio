import api from '../utils/api'


export const getAvailableDeliveries = () => {
    return api.get('/api/rider/deliveries/available')
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
