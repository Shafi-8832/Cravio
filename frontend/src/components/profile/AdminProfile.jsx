import { Link } from 'react-router-dom'
import { StatGrid, Stat } from './ProfileIdentity'
import { money } from '../../utils/format'

const ROLE_LABELS = {
  customer: 'Customers',
  rider: 'Riders',
  restaurant_owner: 'Restaurant owners',
  admin: 'Admins'
}

// Deliberately thin. The admin dashboard is where the work happens; this is
// only the admin's own account page, so it shows the platform in one glance
// and then points at the tools.
export default function AdminProfile({ usersByRole, stats }) {
  return <>
    <section className="mt-6">
      <h2 className="text-xl font-bold mb-4">Platform at a glance</h2>
      <StatGrid>
        <Stat label="Users" value={stats.user_count} />
        <Stat label="Restaurants" value={stats.restaurant_count} hint={`${stats.branch_count} branches`} />
        <Stat label="Orders" value={stats.order_count} hint={`${stats.delivered_order_count} delivered`} />
        <Stat label="Delivered value" value={money(stats.delivered_revenue)} />
      </StatGrid>
    </section>

    <section className="surface p-6 mt-6">
      <h2 className="text-xl font-bold mb-4">Accounts by role</h2>
      <ul className="grid sm:grid-cols-2 gap-3">
        {usersByRole.map(row => <li key={row.role} className="flex justify-between border-b border-stone-100 pb-2">
          <span>{ROLE_LABELS[row.role] || row.role}</span>
          <span className="font-bold">{row.count}</span>
        </li>)}
      </ul>
    </section>

    <section className="surface p-6 mt-6">
      <h2 className="text-xl font-bold mb-3">Admin tools</h2>
      <div className="flex flex-wrap gap-4 text-sm font-bold text-orange-700">
        <Link to="/admin">Admin studio</Link>
        <Link to="/admin" state={{ tab: 'users' }}>Users &amp; suspensions</Link>
        <Link to="/admin" state={{ tab: 'orders' }}>Orders</Link>
      </div>
    </section>
  </>
}
