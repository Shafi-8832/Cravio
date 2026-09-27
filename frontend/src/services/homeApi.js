import api from '../utils/api'
// Customer home page rails. Every number shown (prices, discounts, counts,
// ratings) is computed in SQL; these calls only fetch the finished rows.
export const getHomeBanners = () => api.get('/api/home/banners')
export const getHomeDeals = (limit = 12) => api.get('/api/home/deals', { params: { limit } })
export const getHomePopular = () => api.get('/api/home/popular')
export const getOrderAgain = () => api.get('/api/home/order-again')
export const getTopRestaurants = () => api.get('/api/home/top-restaurants')
