import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CartProvider } from './context/CartContext'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import HomePage from './pages/HomePage'
import DirectoryPage from './pages/DirectoryPage'
import RestaurantPage from './pages/RestaurantPage'
import CheckoutPage from './pages/CheckoutPage'
import MyOrdersPage from './pages/MyOrdersPage'
import AccountPage from './pages/AccountPage'
import OwnerDashboardPage from './pages/OwnerDashboardPage'
import OwnerAnalyticsPage from './pages/OwnerAnalyticsPage'
import OwnerReviewsPage from './pages/OwnerReviewsPage'
import RiderDashboardPage from './pages/RiderDashboardPage'
import AdminDashboardPage from './pages/AdminDashboardPage'
import AdminAnalyticsPage from './pages/AdminAnalyticsPage'
import AdminLiveDeliveriesPage from './pages/AdminLiveDeliveriesPage'

function RoleRoute({ roles, children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (roles && !roles.includes(user.role)) return <main className="page-shell py-20"><h1 className="section-heading">This page is for a different account role.</h1></main>
  return children
}
function PublicOnly({ children }) {
  const { user } = useAuth()
  return user ? <Navigate to="/" replace /> : children
}
function Home() {
  const { user } = useAuth()
  const destination = { admin: '/admin', restaurant_owner: '/owner', rider: '/rider' }[user?.role]
  return destination ? <Navigate to={destination} replace /> : <HomePage />
}
function AppRoutes() {
  return <><Navbar /><Routes>
    <Route path="/" element={<Home />} />
    <Route path="/directory" element={<DirectoryPage />} />
    <Route path="/explore" element={<HomePage />} />
    <Route path="/restaurants/:id" element={<RestaurantPage />} />
    <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
    <Route path="/login/:role" element={<PublicOnly><LoginPage /></PublicOnly>} />
    {/* The staff door, under both the address admins are given and the slug form. */}
    <Route path="/admin/login" element={<PublicOnly><LoginPage staff /></PublicOnly>} />
    <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />
    <Route path="/signup/:role" element={<PublicOnly><SignupPage /></PublicOnly>} />
    <Route path="/account" element={<RoleRoute><AccountPage /></RoleRoute>} />
    {/* One profile route for every role; the page itself branches on the role the server returns. */}
    <Route path="/profile" element={<RoleRoute><AccountPage /></RoleRoute>} />
    <Route path="/checkout" element={<RoleRoute roles={['customer']}><CheckoutPage /></RoleRoute>} />
    <Route path="/orders" element={<RoleRoute roles={['customer']}><MyOrdersPage /></RoleRoute>} />
    <Route path="/owner" element={<RoleRoute roles={['restaurant_owner']}><OwnerDashboardPage /></RoleRoute>} />
    <Route path="/owner/analytics" element={<RoleRoute roles={['restaurant_owner']}><OwnerAnalyticsPage /></RoleRoute>} />
    <Route path="/owner/reviews" element={<RoleRoute roles={['restaurant_owner']}><OwnerReviewsPage /></RoleRoute>} />
    <Route path="/rider" element={<RoleRoute roles={['rider']}><RiderDashboardPage /></RoleRoute>} />
    <Route path="/admin" element={<RoleRoute roles={['admin']}><AdminDashboardPage /></RoleRoute>} />
    <Route path="/admin/analytics" element={<RoleRoute roles={['admin']}><AdminAnalyticsPage /></RoleRoute>} />
    <Route path="/admin/live" element={<RoleRoute roles={['admin']}><AdminLiveDeliveriesPage /></RoleRoute>} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes><Footer /></>
}
export default function App() {
  return <BrowserRouter><AuthProvider><CartProvider><AppRoutes /></CartProvider></AuthProvider></BrowserRouter>
}
