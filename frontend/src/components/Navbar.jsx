import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useCart } from '../context/CartContext'
import CartDrawer from './CartDrawer'
import Icon from './Icon'
import { errorMessage } from '../utils/format'

export default function Navbar() {
  const { user, logout } = useAuth()
  const { itemCount } = useCart()
  const [isCartOpen, setIsCartOpen] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const roleLinks = { restaurant_owner: ['/owner', 'Restaurant studio'], rider: ['/rider', 'Deliveries'], admin: ['/admin', 'Admin studio'] }
  async function handleLogout() {
    try { await logout(); navigate('/'); setError('') }
    catch (err) { setError(errorMessage(err, 'Could not sign out. Please retry so your session can be revoked.')) }
  }
  const activeClass = ({ isActive }) => 'text-sm font-semibold transition-colors hover:text-orange-600 ' + (isActive ? 'text-orange-700' : 'text-stone-600')
  return <>
    <header className="bg-white/95 border-b border-stone-200/60 sticky top-0 z-30 backdrop-blur-md">
      <div className="page-shell h-20 flex items-center gap-6">
        <Link to="/" className="brand text-[31px] flex items-center gap-2.5" aria-label="Cravio home"><span className="bg-orange-600 text-white rounded-xl w-10 h-10 flex items-center justify-center"><Icon name="bag" size={24} /></span>cravio<span className="text-orange-600 -ml-2">.</span></Link>
        <div className="hidden lg:flex items-center gap-2 text-sm pl-6 border-l border-stone-200"><Icon name="pin" className="text-orange-600" /><div><p className="text-[10px] uppercase tracking-widest text-stone-400">Discover in</p><p className="font-semibold">Bangladesh <span className="ml-1">🇧🇩</span></p></div></div>
        <nav aria-label="Main navigation" className="flex items-center gap-5 ml-auto">
          <NavLink to="/" end className={({ isActive }) => 'hidden sm:block ' + activeClass({ isActive })}>Explore</NavLink>
          {user?.role === 'customer' && <NavLink to="/orders" className={activeClass}>Orders</NavLink>}
          {roleLinks[user?.role] && <NavLink to={roleLinks[user.role][0]} className={activeClass}>{roleLinks[user.role][1]}</NavLink>}
          {/* Owners get their analytics one click away, not buried in a tab. */}
          {user?.role === 'restaurant_owner' && <NavLink to="/owner/analytics" className={activeClass}>Analytics</NavLink>}
          {user ? <>
            <Link to="/account" className="icon-button" aria-label="Your account" title={user.name}><Icon name="user" size={18} /></Link>
            <button onClick={handleLogout} className="hidden sm:flex icon-button" aria-label="Sign out" title="Sign out"><Icon name="logout" size={18} /></button>
            {user.role === 'customer' && <button onClick={() => setIsCartOpen(true)} className="btn-primary relative !px-3 sm:!px-4" aria-label={'Open cart, ' + itemCount + ' items'}><Icon name="bag" size={19} /><span className="hidden sm:inline">Cart</span><span className="rounded-full bg-white/20 px-1.5 text-xs">{itemCount}</span></button>}
          </> : <><Link to="/login" className="text-sm font-bold">Log in</Link><Link to="/signup" className="btn-primary !px-3 sm:!px-5">Sign up <Icon name="arrow" size={16} /></Link></>}
        </nav>
      </div>
      {error && <div className="notice-error rounded-none" role="alert">{error}</div>}
    </header>
    <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
  </>
}
