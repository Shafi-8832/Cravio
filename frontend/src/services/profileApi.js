import api from '../utils/api'

// One endpoint for every role. The server decides what comes back by
// reading the role off the verified token, so there is nothing here to
// pass — and nothing a curious user could change to see someone else's page.
export const getProfile = () => api.get('/api/profile')
export const changePassword = payload => api.patch('/api/account/password', payload)
