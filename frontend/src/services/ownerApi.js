import api from '../utils/api'
export const editRestaurant = (id, payload) => api.patch('/api/restaurants/' + id, payload)
export const editMenuItem = (id, payload) => api.patch('/api/menu/items/' + id, payload)
export const addModifierGroup = (id, payload) => api.post('/api/menu/items/' + id + '/modifier-groups', payload)
export const addModifierOption = (id, payload) => api.post('/api/menu/modifier-groups/' + id + '/options', payload)
export const toggleModifierOption = id => api.patch('/api/menu/modifier-options/' + id + '/toggle')
export const deleteModifierGroup = id => api.delete('/api/menu/modifier-groups/' + id)


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


// Analytics. The restaurant id is in the path, and the server re-checks
// that it belongs to the caller before answering — the id being in the URL
// is a request, not a permission.
export const getAnalytics = (restaurantId, range = {}) => {
    return api.get(`/api/owner/analytics/${restaurantId}`, { params: range })
}
