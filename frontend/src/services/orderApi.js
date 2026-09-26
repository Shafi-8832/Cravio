import api from '../utils/api'
export const cancelOrder = id => api.patch('/api/orders/' + id + '/cancel')
export const reviewOrder = (id, payload) => api.post('/api/reviews/orders/' + id, payload)
// Stars + comment about the rider. Write-only from the customer's side:
// nothing a customer, owner or rider can call reads it back — only the
// admin panel does, through getRiderReviews in adminApi.js.
export const reviewRider = (id, payload) => api.post('/api/reviews/orders/' + id + '/rider', payload)
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


// Live map data for one order. Polled every 5 seconds by LiveTrackingMap
// while the order is out for delivery.
export const getOrderTracking = (orderId) => {
    return api.get(`/api/orders/${orderId}/tracking`)
}


// The planned road route for an order ({ routed, geometry, ... }). Fetched
// ONCE when a tracking map opens; the server caches it in order_routes.
export const getOrderRoute = (orderId) => {
    return api.get(`/api/orders/${orderId}/route`)
}
