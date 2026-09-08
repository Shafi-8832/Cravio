import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CartProvider } from './context/CartContext' // NEW: import the cart context
import Navbar from './components/Navbar'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import HomePage from './pages/HomePage'
import RestaurantPage from './pages/RestaurantPage'
import CheckoutPage from './pages/CheckoutPage'
import MyOrdersPage from './pages/MyOrdersPage'
import OwnerDashboardPage from './pages/OwnerDashboardPage'
import RiderDashboardPage from './pages/RiderDashboardPage'
import AdminDashboardPage from './pages/AdminDashboardPage'

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth()       // pull auth state from context
  if (loading) return <div>Loading...</div> // still checking localStorage — wait
  if (!user) return <Navigate to="/login" replace /> // not logged in — bounce to login
  return children                            // logged in — render the page
}

const PublicOnlyRoute = ({ children }) => {
  const { user, loading } = useAuth()
  if (loading) return <div>Loading...</div>
  if (user) return <Navigate to="/" replace /> // already logged in — no need for login/signup
  return children
}

// Restricts a route to specific roles. This is a UX guard only — the real
// enforcement lives on the backend (every endpoint checks the role itself),
// so a blocked page here is never the only thing standing between a role
// and something it shouldn't touch.
const RoleRoute = ({ allowedRoles, children }) => {
  const { user, loading } = useAuth()
  if (loading) return <div>Loading...</div>
  if (!user) return <Navigate to="/login" replace />

  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="max-w-lg mx-auto text-center py-20 px-4">
        <p className="text-5xl mb-4">🚫</p>
        <p className="text-gray-600 text-lg mb-2">Access denied.</p>
        <p className="text-gray-400 text-sm">
          This page isn't available for your account type.
        </p>
      </div>
    )
  }

  return children
}

// "/" is the landing route, but it shows a different view per role — the
// visible, frontend counterpart of the backend's per-role authorization.
const RoleAwareHome = () => {
  const { user } = useAuth()

  if (user.role === 'restaurant_owner') return <Navigate to="/owner" replace />
  if (user.role === 'rider') return <Navigate to="/rider" replace />
  if (user.role === 'admin') return <Navigate to="/admin" replace />

  return <HomePage />
}

const AppRoutes = () => {
  return (
    <>
      <Navbar /> {/* shown on every page */}
      <Routes>
        <Route path="/login" element={
          <PublicOnlyRoute><LoginPage /></PublicOnlyRoute>
        } />
        <Route path="/signup" element={
          <PublicOnlyRoute><SignupPage /></PublicOnlyRoute>
        } />
        <Route path="/" element={
          <ProtectedRoute><RoleAwareHome /></ProtectedRoute>
        } />
        <Route path="/restaurants/:id" element={
          <ProtectedRoute><RestaurantPage /></ProtectedRoute>
        } />

        {/* customer-only */}
        <Route path="/checkout" element={
          <RoleRoute allowedRoles={['customer']}><CheckoutPage /></RoleRoute>
        } />
        <Route path="/orders" element={
          <RoleRoute allowedRoles={['customer']}><MyOrdersPage /></RoleRoute>
        } />

        {/* restaurant_owner-only */}
        <Route path="/owner" element={
          <RoleRoute allowedRoles={['restaurant_owner']}><OwnerDashboardPage /></RoleRoute>
        } />

        {/* rider-only */}
        <Route path="/rider" element={
          <RoleRoute allowedRoles={['rider']}><RiderDashboardPage /></RoleRoute>
        } />

        {/* admin-only */}
        <Route path="/admin" element={
          <RoleRoute allowedRoles={['admin']}><AdminDashboardPage /></RoleRoute>
        } />

        <Route path="*" element={<Navigate to="/" replace />} /> {/* unknown URL -> home */}
      </Routes>
    </>
  )
}

const App = () => {
  return (
    <BrowserRouter>          {/* enables client-side routing */}
      <AuthProvider>          {/* makes user/login/logout available everywhere */}
        <CartProvider>        {/* NEW: makes cart items/addItem/etc available everywhere */}
          <AppRoutes />
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
