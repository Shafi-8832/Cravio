import { Link } from 'react-router-dom'
import { StatGrid, Stat } from './ProfileIdentity'
import { money } from '../../utils/format'

// An owner's profile answers "how is my business doing" in four numbers and
// then lists the restaurants behind them. Nothing here is selected by a
// restaurant id from the browser: the server reached every row by joining
// through restaurants.owner_id, so an owner can only ever see their own.
export default function OwnerProfile({ restaurants, stats }) {
  return <>
    <section className="mt-6">
      <h2 className="text-xl font-bold mb-4">Your business</h2>
      <StatGrid>
        <Stat label="Orders received" value={stats.orders_received} hint={`${stats.orders_in_progress} in progress`} />
        <Stat label="Delivered" value={stats.orders_delivered} />
        <Stat label="Revenue" value={money(stats.revenue)} hint="Delivered orders only" />
        <Stat label="Rating" value={stats.average_rating == null ? 'No reviews' : `${Number(stats.average_rating).toFixed(2)} ★`}
          hint={<Link className="font-bold text-orange-700" to="/owner/reviews">{stats.review_count} review{stats.review_count === 1 ? '' : 's'} →</Link>} />
      </StatGrid>
    </section>

    <section className="surface p-6 mt-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Your restaurants ({stats.restaurant_count})</h2>
        <Link className="text-sm font-bold text-orange-700" to="/owner">Open the kitchen studio →</Link>
      </div>
      {restaurants.length ? <div className="grid md:grid-cols-2 gap-4">
        {restaurants.map(item => <article key={item.id} className="rounded-xl border border-stone-200 p-4">
          <p className="font-extrabold text-lg">{item.name}</p>
          <p className="text-sm muted">{item.cuisine}</p>
          <p className="text-sm mt-3">
            {item.menu_item_count} menu item{item.menu_item_count === 1 ? '' : 's'} ·
            {' '}{item.branch_count} branch{item.branch_count === 1 ? '' : 'es'}
          </p>
          <p className="text-sm muted mt-1">
            {item.avg_rating == null ? 'No reviews yet' : `${Number(item.avg_rating).toFixed(2)} ★ from ${item.review_count} review${item.review_count === 1 ? '' : 's'}`}
          </p>
          <div className="flex gap-4 mt-3">
            {/* Both links land in the owner dashboard, which holds the menu editor and the branch settings. */}
            <Link className="text-sm font-bold text-orange-700" to="/owner" state={{ restaurantId: item.id }}>Edit menu</Link>
            <Link className="text-sm font-bold text-orange-700" to="/owner" state={{ restaurantId: item.id, tab: 'settings' }}>Restaurant settings</Link>
          </div>
        </article>)}
      </div> : <p className="text-sm muted">No restaurant yet. <Link className="font-bold text-orange-700" to="/owner">Create one →</Link></p>}
    </section>
  </>
}
