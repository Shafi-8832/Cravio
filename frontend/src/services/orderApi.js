import api from '../utils/api'
export const cancelOrder = id => api.patch('/api/orders/' + id + '/cancel')
export const reviewOrder = (id, payload) => api.post('/api/reviews/orders/' + id, payload)
export const submitPaymentReference = (id, transaction_ref) => api.post('/api/payments/' + id + '/reference', { transaction_ref })
export const verifyPayment = id => api.patch('/api/payments/' + id + '/status', { status: 'paid' })


export const placeOrder = (payload) => {
    return api.post('/api/orders', payload)
}


export const getMyOrders = (params = {}) => {
    return api.get('/api/orders/my-orders', { params })
}


export const getOrderDetails = (orderId) => {
    return api.get(`/api/orders/${orderId}`)
}
