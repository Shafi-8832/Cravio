import api from '../utils/api'


export const placeOrder = (payload) => {
    return api.post('/api/orders', payload)
}


export const getMyOrders = (params = {}) => {
    return api.get('/api/orders/my-orders', { params })
}


export const getOrderDetails = (orderId) => {
    return api.get(`/api/orders/${orderId}`)
}
