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


export default api // punching a hole in the file and pulling out 'api' object out
// now any react component can do 'import api from '../utils/api.js' pull out this token-attaching postman for their requests