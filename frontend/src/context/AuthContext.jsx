import { Children } from 'react'
import { createContext, useContext, useState, useEffect } from 'react'

// global context to all nesting components
// without passing it as prop through every level
// global variable known to all

const AuthContext = createContext(null)

export const AuthProvider = ({children}) => {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(true)

    // when the app first loads, check if there is a saved user
    useEffect( () => {
        const savedUser = localStorage.getItem('user')
        if (savedUser) {
            setUser(JSON.parse(savedUser))
        }
        setLoading(false)
    }, [])


    const login = (userData, token) => {
        localStorage.setItem('token', token)
        localStorage.setItem('user', user)
        setUser(userData)
    }


    const logout = () => {
        localStorage.removeItem('token')
        localStorage.removeItem(user)
        setUser(null)
    }

    return (
        <AuthContext.Provider value={{user, login, logout, loading}}> 
        {children} 
        </AuthContext.Provider>
    )
}

// custome hook, nice convenience
export const useAuth = () => useContext(AuthContext)