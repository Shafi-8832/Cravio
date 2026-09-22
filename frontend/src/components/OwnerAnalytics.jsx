import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import DateRangePicker, { Bar, Delta, Stat } from './DateRangePicker'
import { defaultRange } from '../utils/dateRange'
import { getAnalytics } from '../services/ownerApi'
import { money, errorMessage } from '../utils/format'


export default function OwnerAnalytics({ restaurantId, onStatusSelect }) {
  const [applied, setApplied] = useState(defaultRange)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!restaurantId) return
    setLoading(true)
    try {
      const response = await getAnalytics(restaurantId, applied)
      setData(response.data)
      setError('')
    } catch (err) {
      setData(null)
      setError(errorMessage(err))
    } finally { setLoading(false) }
  }, [restaurantId, applied])

  // The effect starts remote I/O; the state updates once the API answers.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  if (!restaurantId) return <p className="surface p-6 text-sm muted">Choose a restaurant to see its analytics.</p>
  if (loading && !data) return <p className="surface p-6">Loading analytics…</p>

  const headline = data?.headline
  // A restaurant can exist without ever having been ordered from. Say so
  // plainly rather than printing a page of zeroes and a NaN average.
  const hasOrders = Number(headline?.current_orders || 0) > 0
  const maxDayRevenue = Math.max(0, ...(data?.revenue_by_day || []).map(row => Number(row.revenue)))
  const maxHourOrders = Math.max(0, ...(data?.busiest_hours || []).map(row => row.order_count))
  const maxItemQuantity = Math.max(0, ...(data?.top_items || []).map(row => row.quantity_sold))

  return <section>
    <DateRangePicker onApply={setApplied}>
      {data && <p className="text-xs muted ml-auto">
        {data.restaurant.name} · {data.range.from} → {data.range.to}
        {headline && <> · compared with {headline.previous_from} → {headline.previous_to}</>}
      </p>}
    </DateRangePicker>

    {error && <p className="notice-error mb-5" role="alert">{error}</p>}

    {data && <>
      {/* 1. Headline, with each figure set against the same-length period before it. */}
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
        <Stat label="Customers served" value={headline.current_customers_served}>
          <p className="text-xs muted mt-1">{headline.previous_customers_served} before · distinct people</p>
        </Stat>
        <Stat label="Rating" value={headline.average_rating == null ? 'No reviews' : `${Number(headline.average_rating).toFixed(2)} ★`}>
          {/* The rating is the door into the reviews behind it. */}
          <Link to="/owner/reviews" className="text-xs font-bold text-orange-700 mt-1 inline-block hover:underline">
            {headline.review_count} review{headline.review_count === 1 ? '' : 's'} · read and reply →
          </Link>
        </Stat>
      </div>

      {!hasOrders && <p className="surface p-6 mt-5 text-sm muted">
        No orders in this period yet, so the tables below are empty. Try a wider date range, or come back once your first order arrives.
      </p>}

      {/* 2. Revenue trend. */}
      <section className="surface p-5 mt-5">
        <h3 className="font-bold mb-3">Revenue trend</h3>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left muted text-xs uppercase">
              <th className="pb-2">Day</th><th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Revenue</th>
            </tr></thead>
            <tbody>{data.revenue_by_day.map(row => <tr key={row.day} className="border-t border-stone-100">
              <td className="py-2 w-1/2">{row.day}<Bar value={row.revenue} max={maxDayRevenue} /></td>
              <td className="py-2 text-right align-top">{row.order_count}</td>
              <td className="py-2 text-right font-bold align-top">{money(row.revenue)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-xs muted mt-2">Every day in the range is listed, including days with no orders.</p>
      </section>

      <div className="grid lg:grid-cols-2 gap-5 mt-5">
        {/* 3. Top items. */}
        <section className="surface p-5">
          <h3 className="font-bold mb-3">Top selling items</h3>
          {data.top_items.length ? <table className="w-full text-sm">
            <thead><tr className="text-left muted text-xs uppercase">
              <th className="pb-2">Item</th><th className="pb-2 text-right">Sold</th><th className="pb-2 text-right">Revenue</th>
            </tr></thead>
            <tbody>{data.top_items.map(row => <tr key={row.id} className="border-t border-stone-100">
              <td className="py-2">{row.name}<Bar value={row.quantity_sold} max={maxItemQuantity} /></td>
              <td className="py-2 text-right font-bold align-top">{row.quantity_sold}</td>
              <td className="py-2 text-right align-top">{money(row.revenue)}</td>
            </tr>)}</tbody>
          </table> : <p className="text-sm muted">Nothing sold in this period.</p>}
        </section>

        {/* 4. Busiest hours. */}
        <section className="surface p-5">
          <h3 className="font-bold mb-3">Busiest hours</h3>
          {data.busiest_hours.length ? <table className="w-full text-sm">
            <thead><tr className="text-left muted text-xs uppercase">
              <th className="pb-2">Hour</th><th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Revenue</th>
            </tr></thead>
            <tbody>{data.busiest_hours.map(row => <tr key={row.hour} className="border-t border-stone-100">
              <td className="py-2 w-1/2">{String(row.hour).padStart(2, '0')}:00<Bar value={row.order_count} max={maxHourOrders} /></td>
              <td className="py-2 text-right font-bold align-top">{row.order_count}</td>
              <td className="py-2 text-right align-top">{money(row.revenue)}</td>
            </tr>)}</tbody>
          </table> : <p className="text-sm muted">No orders in this period.</p>}
        </section>
      </div>

      {/* 5. Status breakdown — each row opens the order list filtered to that status. */}
      <section className="surface p-5 mt-5">
        <h3 className="font-bold mb-3">Orders by status</h3>
        {data.status_breakdown.length ? <table className="w-full text-sm">
          <thead><tr className="text-left muted text-xs uppercase">
            <th className="pb-2">Status</th><th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Value</th>
          </tr></thead>
          <tbody>{data.status_breakdown.map(row => <tr key={row.status} className="border-t border-stone-100">
            <td className="py-2 capitalize">
              {onStatusSelect
                ? <button type="button" className="text-orange-700 font-semibold hover:underline capitalize"
                  onClick={() => onStatusSelect(row.status)}>
                  {row.status.replaceAll('_', ' ')} →
                </button>
                : row.status.replaceAll('_', ' ')}
            </td>
            <td className="py-2 text-right font-bold">{row.order_count}</td>
            <td className="py-2 text-right">{money(row.order_value)}</td>
          </tr>)}</tbody>
        </table> : <p className="text-sm muted">No orders in this period.</p>}
        {onStatusSelect && data.status_breakdown.length > 0 &&
          <p className="text-xs muted mt-2">Pick a status to open the order list filtered to it.</p>}
      </section>
    </>}
  </section>
}
