import { useState, useEffect, useCallback } from 'react'
import LoadingSpinner from '../components/LoadingSpinner'
import { getUsers, updateUserStatus, getStats } from '../services/adminApi'

const ROLE_LABELS = {
  customer: 'Customer',
  restaurant_owner: 'Restaurant Owner',
  rider: 'Rider',
  admin: 'Admin'
}

const AdminDashboardPage = () => {
  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [roleFilter, setRoleFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const flashNotice = (message) => {
    setNotice(message)
    setTimeout(() => setNotice(''), 3000)
  }

  const loadUsers = useCallback(async () => {
    try {
      const res = await getUsers({ role: roleFilter || undefined })
      setUsers(res.data.users)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load users.')
    }
  }, [roleFilter])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')

      try {
        const [usersRes, statsRes] = await Promise.all([
          getUsers({ role: roleFilter || undefined }),
          getStats()
        ])
        setUsers(usersRes.data.users)
        setStats(statsRes.data)
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to load admin data.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [roleFilter])

  const handleToggleStatus = async (user) => {
    setError('')

    try {
      await updateUserStatus(user.id, !user.is_active)
      await loadUsers()
      flashNotice(`${user.name} ${user.is_active ? 'suspended' : 'reactivated'}.`)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update user.')
    }
  }

  if (loading) return <LoadingSpinner message="Loading admin panel..." />

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-800 mb-1">Admin Panel</h1>
      <p className="text-gray-500 mb-6">Platform-wide overview and user management.</p>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-green-50 text-green-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {notice}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          {stats.users_by_role.map(row => (
            <div
              key={row.role}
              className="bg-white rounded-xl border border-gray-100 p-4 text-center"
            >
              <p className="text-2xl font-bold text-gray-800">{row.count}</p>
              <p className="text-xs text-gray-400 capitalize">
                {ROLE_LABELS[row.role] || row.role}
              </p>
            </div>
          ))}
          <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
            <p className="text-2xl font-bold text-gray-800">{stats.restaurant_count}</p>
            <p className="text-xs text-gray-400">Restaurants</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="font-semibold text-gray-700">Users</h2>
          <select
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white
                       focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">All roles</option>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-gray-50">
                  <td className="py-2 pr-4 text-gray-700">{u.name}</td>
                  <td className="py-2 pr-4 text-gray-500">{u.email}</td>
                  <td className="py-2 pr-4 text-gray-500 capitalize">
                    {ROLE_LABELS[u.role] || u.role}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                      u.is_active
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-600'
                    }`}>
                      {u.is_active ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {u.role !== 'admin' && (
                      <button
                        onClick={() => handleToggleStatus(u)}
                        className="text-xs px-3 py-1 rounded-full font-medium
                                   bg-gray-100 text-gray-600 hover:bg-gray-200"
                      >
                        {u.is_active ? 'Suspend' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default AdminDashboardPage
