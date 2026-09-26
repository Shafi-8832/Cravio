import api from '../utils/api'
export const listRestaurants = (params = {}) => api.get('/api/restaurants', { params })
export const getRestaurant = id => api.get('/api/restaurants/' + id)
export const getRestaurantMenu = id => api.get('/api/menu/restaurants/' + id)
export const getRestaurantReviews = id => api.get('/api/reviews/restaurants/' + id)
// Branches within radius_km of a point, closest first (distance computed in SQL).
export const getNearbyRestaurants = (lat, lng, radiusKm) => api.get('/api/restaurants/nearby', { params: { lat, lng, radius_km: radiusKm } })
