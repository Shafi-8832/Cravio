import api from '../utils/api'
export const listRestaurants = (params = {}) => api.get('/api/restaurants', { params })
export const getRestaurant = id => api.get('/api/restaurants/' + id)
export const getRestaurantMenu = id => api.get('/api/menu/restaurants/' + id)
export const getRestaurantReviews = id => api.get('/api/reviews/restaurants/' + id)
// Branches within radius_km of a point, closest first (distance computed in SQL).
export const getNearbyRestaurants = (lat, lng, radiusKm) => api.get('/api/restaurants/nearby', { params: { lat, lng, radius_km: radiusKm } })

// Rating breakdown for the reviews drawer: one row per star (5..1) plus the
// total and average, all computed by PostgreSQL in a single query.
export const getReviewSummary = id => api.get(`/api/restaurants/${id}/reviews/summary`)
// One page of that restaurant's reviews, newest first. limit is capped at 50
// by the server, so asking for more comes back as a 400 rather than a huge page.
export const getReviewPage = (id, { limit = 10, offset = 0 } = {}) =>
  api.get(`/api/restaurants/${id}/reviews`, { params: { limit, offset } })
// Every orderable branch of one restaurant measured from (lat, lng), best
// first, plus selected_branch_id (nearest open branch that delivers there).
export const getRestaurantBranches = (id, lat, lng) => api.get('/api/restaurants/' + id + '/branches', { params: { lat, lng } })
