import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const Navbar = () => {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <nav className="bg-green-700 text-white px-6 py-4 flex items-center justify-between shadow-md">
      
      {/* Logo */}
      <Link to="/" className="text-2xl font-bold tracking-tight">
        Cravio
      </Link>

      {/* Right side */}
      <div className="flex items-center gap-4">
        {user ? (
          <>
            <span className="text-sm text-green-100">
              Hello, {user.name.split(' ')[0]}
            </span>
            <span className="text-xs bg-green-800 px-2 py-1 rounded-full capitalize">
              {user.role.replace('_', ' ')}
            </span>
            <button
              onClick={handleLogout}
              className="bg-white text-green-700 px-4 py-1 rounded-lg 
                         text-sm font-semibold hover:bg-green-50 transition-colors"
            >
              Logout
            </button>
          </>
        ) : (
          <>
            <Link 
              to="/login"
              className="text-sm hover:text-green-200 transition-colors"
            >
              Login
            </Link>
            <Link 
              to="/signup"
              className="bg-white text-green-700 px-4 py-1 rounded-lg 
                         text-sm font-semibold hover:bg-green-50 transition-colors"
            >
              Sign Up
            </Link>
          </>
        )}
      </div>
    </nav>
  )
}

export default Navbar