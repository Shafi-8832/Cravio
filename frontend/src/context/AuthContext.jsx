import { createContext, useContext, useEffect, useState } from 'react'
import { signOut } from '../services/authApi'

const AuthContext = createContext(null)
const readUser = () => {
  try { return localStorage.getItem('token') ? JSON.parse(localStorage.getItem('user')) : null }
  catch { return null }
}
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(readUser)
  useEffect(() => {
    const clear = () => setUser(null)
    window.addEventListener('cravio:session-ended', clear)
    return () => window.removeEventListener('cravio:session-ended', clear)
  }, [])
  const login = (userData, token) => {
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(userData))
    setUser(userData)
  }
  const refreshUser = userData => {
    localStorage.setItem('user', JSON.stringify(userData))
    setUser(userData)
  }
  const logout = async () => {
    // A failed revocation stays visible, so logout is never falsely reported.
    await signOut()
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }
  return <AuthContext.Provider value={{ user, loading: false, login, logout, refreshUser }}>{children}</AuthContext.Provider>
}
export const useAuth = () => useContext(AuthContext)
