import api from '../utils/api'


export const getMyRestaurants = () => {
    return api.get('/api/restaurants/mine')
}


export const createRestaurant = (name) => {
    return api.post('/api/restaurants', { name })
}


export const addBranch = (restaurantId, payload) => {
    return api.post(`/api/restaurants/${restaurantId}/branches`, payload)
}


export const toggleBranch = (branchId) => {
    return api.patch(`/api/restaurants/branches/${branchId}/toggle`)
}


export const getMenu = (restaurantId) => {
    return api.get(`/api/menu/restaurants/${restaurantId}`)
}


export const createCategory = (restaurantId, name) => {
    return api.post(`/api/menu/restaurants/${restaurantId}/categories`, { name })
}


export const createMenuItem = (categoryId, payload) => {
    return api.post(`/api/menu/categories/${categoryId}/items`, payload)
}


export const toggleMenuItem = (itemId) => {
    return api.patch(`/api/menu/items/${itemId}/toggle`)
}


export const deleteMenuItem = (itemId) => {
    return api.delete(`/api/menu/items/${itemId}`)
}


export const getRestaurantOrders = (params = {}) => {
    return api.get('/api/orders/restaurant', { params })
}


export const updateOrderStatus = (orderId, status) => {
    return api.patch(`/api/orders/${orderId}/status`, { status })
}
