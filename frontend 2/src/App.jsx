import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CartProvider } from './context/CartContext' // NEW: import the cart context
import Navbar from './components/Navbar'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import HomePage from './pages/HomePage'
import RestaurantPage from './pages/RestaurantPage'

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
          <ProtectedRoute><HomePage /></ProtectedRoute>
        } />
        <Route path="/restaurants/:id" element={
          <ProtectedRoute><RestaurantPage /></ProtectedRoute>
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