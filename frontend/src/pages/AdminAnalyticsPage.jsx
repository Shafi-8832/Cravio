import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import DateRangePicker, { Bar, Delta, Stat } from '../components/DateRangePicker'
import { defaultRange } from '../utils/dateRange'
import { getPlatformAnalytics } from '../services/adminApi'
import { money, errorMessage } from '../utils/format'

const ROLE_LABELS = {
  customer: 'Customers',
  rider: 'Riders',
  restaurant_owner: 'Restaurant owners',
  admin: 'Admins'
}

// The whole platform in one page. Everything shown here was counted by
// PostgreSQL — this file only decides where the numbers sit and what colour
// the arrows are. The route is admin-only in the router, but that is only
// tidiness: the API refuses a non-admin regardless of what the browser does.
export default function AdminAnalyticsPage() {
  const [applied, setApplied] = useState(defaultRange)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getPlatformAnalytics(applied)
      setData(response.data)
      setError('')
    } catch (err) {
      setData(null)
      setError(errorMessage(err))
    } finally { setLoading(false) }
  }, [applied])

  // The effect starts remote I/O; the state updates once the API answers.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const headline = data?.headline
  // A quiet period is normal, and so is a brand-new platform. Say so in
  // words rather than printing a wall of zeroes and a NaN average.
  const hasOrders = Number(headline?.current_orders || 0) > 0
  const maxDayRevenue = Math.max(0, ...(data?.trend || []).map(row => Number(row.revenue)))
  const maxSignups = Math.max(0, ...(data?.user_growth || []).map(row => row.signups))
  const maxRestaurantRevenue = Math.max(0, ...(data?.top_restaurants || []).map(row => Number(row.revenue)))

  return <main className="page-shell py-9">
    <div className="dashboard-heading flex justify-between items-center gap-3">
      <div>
        <p className="eyebrow mb-2">The whole platform, counted</p>
        <h1 className="section-heading">Platform analytics 📈</h1>
      </div>
      <Link className="btn-secondary" to="/admin">Back to the control room</Link>
    </div>

    <DateRangePicker onApply={setApplied}>
      {data && <p className="text-xs muted ml-auto">
        {data.range.from} → {data.range.to}
        {headline && <> · compared with {headline.previous_from} → {headline.previous_to}</>}
      </p>}
    </DateRangePicker>

    {error && <p className="notice-error mb-5" role="alert">{error}</p>}
    {loading && !data && <p className="surface p-6">Loading platform analytics…</p>}

    {data && <>
      {/* 1. Headline, each figure against the same-length period before it. */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat label="Revenue" value={money(headline.current_revenue)}>
          <Delta percent={headline.revenue_change_pct} previous={money(headline.previous_revenue)} />
        </Stat>
        <Stat label="Orders" value={headline.current_orders}>
          <Delta percent={headline.orders_change_pct} previous={headline.previous_orders} />
        </Stat>
        <Stat label="Average order" value={hasOrders ? money(headline.current_average_order_value) : '—'}>
          <Delta percent={headline.average_order_value_change_pct}
            previous={headline.previous_average_order_value == null ? 'nothing' : money(headline.previous_average_order_value)} />
        </Stat>
        <Stat label="New signups" value={headline.current_signups}>
          <Delta percent={headline.signups_change_pct} previous={headline.previous_signups} />
        </Stat>
        <Stat label="Platform" value={headline.total_users}>
          <p className="text-xs muted mt-1">
            users · {headline.total_restaurants} restaurants · {headline.lifetime_orders} orders all time
          </p>
        </Stat>
      </div>

      {!hasOrders && <p className="surface p-6 mt-5 text-sm muted">
        No orders in this period. The tables below cover the same window, so widen the range to see more.
      </p>}

      {/* 2. Orders and revenue over time. */}
      <section className="surface p-5 mt-5">
        <h3 className="font-bold mb-3">Orders and revenue over time</h3>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left muted text-xs uppercase">
              <th className="pb-2">Day</th><th className="pb-2 text-right">Orders</th>
              <th className="pb-2 text-right">Cancelled</th><th className="pb-2 text-right">Revenue</th>
            </tr></thead>
            <tbody>{data.trend.map(row => <tr key={row.day} className="border-t border-stone-100">
              <td className="py-2 w-1/2">{row.day}<Bar value={row.revenue} max={maxDayRevenue} /></td>
              <td className="py-2 text-right align-top">{row.order_count}</td>
              <td className="py-2 text-right align-top muted">{row.cancelled_count}</td>
              <td className="py-2 text-right font-bold align-top">{money(row.revenue)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-xs muted mt-2">Every day in the range is listed, including days with no orders.</p>
      </section>

      {/* 3. Top restaurants by revenue. */}
      <section className="surface p-5 mt-5">
        <h3 className="font-bold mb-3">Top restaurants by revenue</h3>
        {data.top_restaurants.length ? <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left muted text-xs uppercase">
            <th className="pb-2">Restaurant</th><th className="pb-2">Owner</th>
            <th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Customers</th>
            <th className="pb-2 text-right">Rating</th><th className="pb-2 text-right">Revenue</th>
          </tr></thead>
          <tbody>{data.top_restaurants.map(row => <tr key={row.id} className="border-t border-stone-100">
            <td className="py-2 w-1/3">{row.name}<Bar value={row.revenue} max={maxRestaurantRevenue} /></td>
            <td className="py-2 align-top muted">{row.owner_name || '—'}</td>
            <td className="py-2 text-right align-top">{row.order_count}</td>
            <td className="py-2 text-right align-top">{row.customers}</td>
            <td className="py-2 text-right align-top">{row.average_rating == null ? '—' : `${Number(row.average_rating).toFixed(2)} ★`}</td>
            <td className="py-2 text-right font-bold align-top">{money(row.revenue)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm muted">No restaurant took an order in this period.</p>}
      </section>

      {/* 4. Rider performance. */}
      <section className="surface p-5 mt-5">
        <h3 className="font-bold mb-3">Rider performance</h3>
        {data.rider_performance.length ? <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left muted text-xs uppercase">
            <th className="pb-2">Rider</th><th className="pb-2 text-right">Completed</th>
            <th className="pb-2 text-right">Accepted</th><th className="pb-2 text-right">Average time</th>
            <th className="pb-2 text-right">On time</th><th className="pb-2 text-right">Fees</th>
          </tr></thead>
          <tbody>{data.rider_performance.map(row => <tr key={row.rider_id} className="border-t border-stone-100">
            <td className="py-2">{row.rider_name}</td>
            <td className="py-2 text-right font-bold">{row.deliveries_completed}</td>
            <td className="py-2 text-right muted">{row.deliveries_assigned}</td>
            <td className="py-2 text-right">{row.average_delivery_minutes == null ? '—' : `${row.average_delivery_minutes} min`}</td>
            <td className="py-2 text-right">{row.on_time_rate_pct == null ? '—' : `${row.on_time_rate_pct}%`}</td>
            <td className="py-2 text-right">{money(row.delivery_fees)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm muted">No rider took a delivery in this period.</p>}
        <p className="text-xs muted mt-2">
          Average time runs from the order being placed to it being handed over. “On time” means it arrived within the branch’s quoted maximum.
        </p>
      </section>

      <div className="grid lg:grid-cols-2 gap-5 mt-5">
        {/* 5. User growth and composition. */}
        <section className="surface p-5">
          <h3 className="font-bold mb-3">New accounts per day</h3>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left muted text-xs uppercase">
                <th className="pb-2">Day</th><th className="pb-2 text-right">Signups</th>
                <th className="pb-2 text-right">Cust.</th><th className="pb-2 text-right">Riders</th><th className="pb-2 text-right">Owners</th>
              </tr></thead>
              <tbody>{data.user_growth.map(row => <tr key={row.day} className="border-t border-stone-100">
                <td className="py-2 w-2/5">{row.day}<Bar value={row.signups} max={maxSignups} /></td>
                <td className="py-2 text-right font-bold align-top">{row.signups}</td>
                <td className="py-2 text-right align-top muted">{row.customers}</td>
                <td className="py-2 text-right align-top muted">{row.riders}</td>
                <td className="py-2 text-right align-top muted">{row.restaurant_owners}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="surface p-5">
          <h3 className="font-bold mb-3">Who is on the platform</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-left muted text-xs uppercase">
              <th className="pb-2">Role</th><th className="pb-2 text-right">Accounts</th>
              <th className="pb-2 text-right">Active</th><th className="pb-2 text-right">Share</th>
            </tr></thead>
            <tbody>{data.user_composition.map(row => <tr key={row.role} className="border-t border-stone-100">
              <td className="py-2">{ROLE_LABELS[row.role] || row.role}</td>
              <td className="py-2 text-right font-bold">{row.user_count}</td>
              <td className="py-2 text-right">{row.active_count}</td>
              <td className="py-2 text-right">{row.share_pct}%</td>
            </tr>)}</tbody>
          </table>
          <p className="text-xs muted mt-2">Composition is the standing total, not limited to the date range.</p>
        </section>
      </div>

      {/* 6. Order status breakdown, percentages computed in SQL. */}
      <section className="surface p-5 mt-5">
        <h3 className="font-bold mb-3">Orders by status</h3>
        {data.status_breakdown.length ? <table className="w-full text-sm">
          <thead><tr className="text-left muted text-xs uppercase">
            <th className="pb-2">Status</th><th className="pb-2 text-right">Orders</th>
            <th className="pb-2 text-right">Share</th><th className="pb-2 text-right">Value</th>
          </tr></thead>
          <tbody>{data.status_breakdown.map(row => <tr key={row.status} className="border-t border-stone-100">
            <td className="py-2 capitalize">{row.status.replaceAll('_', ' ')}</td>
            <td className="py-2 text-right font-bold">{row.order_count}</td>
            <td className="py-2 text-right">{row.percentage}%</td>
            <td className="py-2 text-right">{money(row.order_value)}</td>
          </tr>)}</tbody>
        </table> : <p className="text-sm muted">No orders in this period.</p>}
      </section>
    </>}
  </main>
}
