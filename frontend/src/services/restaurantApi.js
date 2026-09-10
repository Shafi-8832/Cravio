import api from '../utils/api'
export const listRestaurants = (params = {}) => api.get('/api/restaurants', { params })
export const getRestaurant = id => api.get('/api/restaurants/' + id)
export const getRestaurantMenu = id => api.get('/api/menu/restaurants/' + id)
export const getRestaurantReviews = id => api.get('/api/reviews/restaurants/' + id)
