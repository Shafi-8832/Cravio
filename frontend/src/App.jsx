import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Navbar from './components/Navbar'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import HomePage from './pages/HomePage'

// ProtectedRoute: wraps any page that requires login
// If not logged in → redirect to /login
// If logged in → show the page
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth()
  
  if (loading) return <div>Loading...</div>
  if (!user) return <Navigate to="/login" replace />
  return children
}

// PublicOnlyRoute: wraps login/signup pages
// If already logged in → redirect to home (no point showing login again)
const PublicOnlyRoute = ({ children }) => {
  const { user, loading } = useAuth()
  
  if (loading) return <div>Loading...</div>
  if (user) return <Navigate to="/" replace />
  return children
}

const AppRoutes = () => {
  return (
    <>
      <Navbar />
      <Routes>
        {/* Public routes */}
        <Route 
          path="/login" 
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          } 
        />
        <Route 
          path="/signup" 
          element={
            <PublicOnlyRoute>
              <SignupPage />
            </PublicOnlyRoute>
          } 
        />

        {/* Protected routes */}
        <Route 
          path="/" 
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          } 
        />

        {/* Catch all — redirect unknown URLs to home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App // make it available for the main.jsx for use (the file that actually injects React code into HTML document)