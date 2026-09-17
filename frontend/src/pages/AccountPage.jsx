import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getProfile } from '../services/profileApi'
import ProfileIdentity from '../components/profile/ProfileIdentity'
import CustomerProfile from '../components/profile/CustomerProfile'
import RiderProfile from '../components/profile/RiderProfile'
import OwnerProfile from '../components/profile/OwnerProfile'
import AdminProfile from '../components/profile/AdminProfile'
import SupportPanel from '../components/SupportPanel'
import { errorMessage } from '../utils/format'

// One page, one route, four faces. Which face is drawn is decided by
// `profile.role` — the role the SERVER put in the response after reading it
// from the users table. It is deliberately not taken from the AuthContext
// copy in localStorage, which a user could edit in their browser. Editing it
// would change nothing anyway: the payload itself only ever contains what
// the server was willing to compute for the role in the verified token.
function RoleSection({ profile }) {
  switch (profile.role) {
    case 'customer':
      return <CustomerProfile stats={profile.stats} recentOrders={profile.recent_orders} />
    case 'rider':
      return <RiderProfile riderProfile={profile.rider_profile} stats={profile.stats} recentDeliveries={profile.recent_deliveries} />
    case 'restaurant_owner':
      return <OwnerProfile restaurants={profile.restaurants} stats={profile.stats} />
    case 'admin':
      return <AdminProfile usersByRole={profile.users_by_role} stats={profile.stats} />
    default:
      return null
  }
}

export default function AccountPage() {
  const { user, logout } = useAuth()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState('')

  // The effect starts remote I/O; setProfile runs after the API response.
  useEffect(() => {
    getProfile().then(response => setProfile(response.data)).catch(err => setError(errorMessage(err)))
  }, [])

  return <main className="page-shell py-9">
    <div className="dashboard-heading flex justify-between items-center gap-3">
      <div>
        <p className="eyebrow mb-2">Your little corner</p>
        <h1 className="section-heading">Hello, {user.name.split(' ')[0]} 👋</h1>
      </div>
      <button className="btn-secondary" onClick={() => logout().catch(err => setError(errorMessage(err)))}>Sign out</button>
    </div>

    {error && <p className="notice-error mb-4" role="alert">{error}</p>}

    {!profile
      ? <p className="surface p-8">Loading your profile…</p>
      : <>
        <ProfileIdentity user={profile.user} />
        <RoleSection profile={profile} />
      </>}

    <SupportPanel admin={user.role === 'admin'} />
  </main>
}
