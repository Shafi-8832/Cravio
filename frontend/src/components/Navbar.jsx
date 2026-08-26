import { useState } from 'react' // NEW: local state to track if the cart drawer is open
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useCart } from '../context/CartContext' // NEW: read cart item count
import CartDrawer from './CartDrawer' // NEW: the slide-over panel component

const Navbar = () => {
  const { user, logout } = useAuth()               // current user + logout function
  const { itemCount } = useCart()                   // NEW: how many items are in the cart

  const canUseCart = user?.role === 'customer'
  const [isCartOpen, setIsCartOpen] = useState(false) // NEW: drawer open/closed state
  const navigate = useNavigate()                     // lets us redirect after logout

  const handleLogout = () => {
    logout()            // clear auth state + localStorage
    navigate('/login')  // send the user to the login page
  }

  return (
    <nav className="bg-green-700 text-white px-6 py-4 flex items-center justify-between shadow-md">

      {/* Logo — clicking it always goes home */}
      <Link to="/" className="text-2xl font-bold tracking-tight">
        Cravio
      </Link>

      {/* Right side of the navbar */}
      <div className="flex items-center gap-4">
        {user ? (
          // ---- logged-in view ----
          <>
            <span className="text-sm text-green-100">
              Hello, {user.name.split(' ')[0]} {/* first name only */}
            </span>
            <span className="text-xs bg-green-800 px-2 py-1 rounded-full capitalize">
              {user.role.replace('_', ' ')} {/* e.g. "restaurant owner" */}
            </span>

            {/* NEW: cart button, opens the CartDrawer */}
            { canUseCart && ( 
              <button
                onClick={() => setIsCartOpen(true)} // flip drawer open
                className="relative bg-green-800 hover:bg-green-900 transition-colors
                          w-9 h-9 rounded-full flex items-center justify-center"
              >
                🛒
                {itemCount > 0 && (
                  // small red badge showing how many items are in the cart
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white
                                    text-[10px] font-bold rounded-full w-5 h-5
                                    flex items-center justify-center">
                    {itemCount}
                  </span>
                )}
              </button>)
            }

            <button
              onClick={handleLogout}
              className="bg-white text-green-700 px-4 py-1 rounded-lg 
                         text-sm font-semibold hover:bg-green-50 transition-colors"
            >
              Logout
            </button>
          </>
        ) : (
          // ---- logged-out view ----
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

      {/* NEW: the cart drawer lives here so it can overlay the whole app;
          it renders nothing when isCartOpen is false */}
      <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
    </nav>
  )
}

export default Navbar