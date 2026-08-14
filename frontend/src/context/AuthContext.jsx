import { createContext, useContext, useState, useEffect } from 'react'
// removed the unused/incorrect `Children` import--> not needed

// global context object — components subscribe to this instead of
// passing user/login/logout down through props at every level
const AuthContext = createContext(null)

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)       // currently logged-in user (or null)
  const [loading, setLoading] = useState(true) // true until we've checked localStorage once

  // runs ONCE when the app first mounts (empty [] dependency array)
  useEffect(() => {
    const savedUser = localStorage.getItem('user') // read the saved user string, if any
    if (savedUser) {
      setUser(JSON.parse(savedUser)) // turn the saved JSON string back into an object
    }
    setLoading(false) // done checking — let ProtectedRoute/PublicOnlyRoute render now
  }, []) // empty array = run only on first render

  const login = (userData, token) => {
    localStorage.setItem('token', token)                    // save the JWT so api.js can attach it later
    localStorage.setItem('user', JSON.stringify(userData))  // FIX: stringify the object before saving
    setUser(userData)                                        // update React state so the UI re-renders
  }

  const logout = () => {
    localStorage.removeItem('token') // remove the saved JWT
    localStorage.removeItem('user')  // FIX: pass the string 'user' (the key), not the `user` variable
    setUser(null)                    // clear React state so the UI re-renders as logged out
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

// custom hook so components just do: const { user, login, logout } = useAuth()
export const useAuth = () => useContext(AuthContext)