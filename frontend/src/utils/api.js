import axios from 'axios'

// one instance of axios(postman) for the whole app
// every API call goes through this


const api = axios.create(
    {
        baseURL: 'http://localhost:8000',
    }
)

// this runs automatically before EVERY REQUEST
// it reads the jwt from the local storage and attaches the JWT to the header of the request
// so we never have to manually add the token to each COMPONENT

api.
interceptors. // two types of interceptors : one for OUTGOING 'request', another for INCOMING 'response' from backend
request. // use the speecific interceptor for OUTGOING requests to server
use(
    (config) => {
        const token = localStorage.getItem('token')

        if (token) { // the exact same auth header in postman
            config.headers.Authorization = `Bearer ${token}`
        }

        return config
    }
)


// this runs automatically after EVERY RESPONSE comes back
// if the backend says our token is invalid/expired/revoked (401), our local
// session is stale — clear it and send the user back to login instead of
// leaving every future request failing silently
// (skipped while already ON the login page, so a wrong-password 401 there
// just shows the normal inline error instead of forcing a reload)
api.
interceptors.
response.
use(
    (response) => response,
    (error) => {
        if (
            error.response?.status === 401 &&
            window.location.pathname !== '/login'
        ) {
            localStorage.removeItem('token')
            localStorage.removeItem('user')
            window.location.href = '/login'
        }

        return Promise.reject(error)
    }
)

export default api // punching a hole in the file and pulling out 'api' object out
// now any react component can do 'import api from '../utils/api.js' pull out this token-attaching postman for their requests