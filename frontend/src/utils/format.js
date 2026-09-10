export const DIVISIONS = ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Barishal', 'Sylhet', 'Rangpur', 'Mymensingh']
export const money = value => '৳' + Number(value || 0).toLocaleString('en-BD', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
export const errorMessage = (error, fallback = 'Something went wrong. Please try again.') => error.response?.data?.error || (error.code === 'ERR_NETWORK' ? 'Cannot reach the server. Check your connection and make sure the Cravio backend is running.' : fallback)
// The hero slideshow. These are the freely-licensed Commons photographs
// downloaded by backend/scripts/fetchCommonsPhotos.js and served from the
// API's /media route, so the homepage shows real food rather than icons.
export const heroSlides = [
  { src: '/media/dish-kacchi-biryani.jpg', alt: 'Kacchi biryani on a plate' },
  { src: '/media/dish-burger.jpg', alt: 'A cheeseburger' },
  { src: '/media/dish-margherita.jpg', alt: 'A margherita pizza' },
  { src: '/media/dish-chicken-bucket.jpg', alt: 'A bucket of fried chicken' },
  { src: '/media/dish-butter-chicken.jpg', alt: 'Butter chicken curry' },
  { src: '/media/dish-seekh-kebab.jpg', alt: 'Seekh kebabs off the grill' },
]

export const foodPhotos = {
  hero: '/media/burger.jpg',
  pizza: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=700&q=85',
  bowl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=700&q=85',
}
