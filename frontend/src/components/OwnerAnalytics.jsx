import { useCallback, useEffect, useState } from 'react'
import { getAnalytics } from '../services/ownerApi'
import { money, errorMessage } from '../utils/format'

const iso = date => date.toISOString().slice(0, 10)

// The presets, as "how many days back does this window start". Today is a
// one-day window, so it starts 0 days back.
const PRESETS = [
  { key: 'today', label: 'Today', daysBack: 0 },
  { key: '7', label: '7 days', daysBack: 6 },
  { key: '30', label: '30 days', daysBack: 29 }
]

function rangeFor(daysBack) {
  const today = new Date()
  const start = new Date(today)
  start.setDate(today.getDate() - daysBack)
  return { from: iso(start), to: iso(today) }
}

// A bar drawn with a div, so the dashboard needs no charting library.
// The widest value in the list is 100% and everything else is measured
// against it — that comparison is presentation, not a statistic, and the
// numbers beside each bar are the ones the database computed.
function Bar({ value, max }) {
  const width = max > 0 ? Math.max((Number(value) / max) * 100, value > 0 ? 2 : 0) : 0
  return <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
    <div className="h-full bg-green-700 rounded-full" style={{ width: width + '%' }} />
  </div>
}

// The percentage itself arrives already calculated by PostgreSQL. All this
// does is decide whether it is green or red and which arrow to draw. A null
// means the previous period had nothing to compare against.
function Delta({ percent, previous }) {
  if (percent == null) {
    return <p className="text-xs muted mt-1">{previous} before · no comparison</p>
  }
  const value = Number(percent)
  const tone = value > 0 ? 'text-green-700' : value < 0 ? 'text-red-600' : 'muted'
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '='
  return <p className={'text-xs mt-1 font-semibold ' + tone}>
    {arrow} {Math.abs(value)}% <span className="muted font-normal">vs {previous}</span>
  </p>
}

function Stat({ label, value, children }) {
  return <div className="surface p-4">
    <p className="text-xs muted uppercase tracking-wide">{label}</p>
    <p className="text-2xl font-extrabold mt-1">{value}</p>
    {children}
  </div>
}

export default function OwnerAnalytics({ restaurantId, onStatusSelect }) {
  const [preset, setPreset] = useState('30')
  const [custom, setCustom] = useState(() => rangeFor(29))
  const [applied, setApplied] = useState(() => rangeFor(29))
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

  function choosePreset(item) {
    setPreset(item.key)
    const range = rangeFor(item.daysBack)
    setCustom(range)
    setApplied(range)
  }

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
    <div className="surface p-4 mb-5">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(item => <button
          key={item.key}
          type="button"
          onClick={() => choosePreset(item)}
          className={'px-3 py-1.5 rounded-full text-sm font-semibold border transition-colors ' +
            (preset === item.key ? 'bg-green-700 text-white border-green-700' : 'border-stone-200 text-stone-600 hover:border-stone-400')}>
          {item.label}
        </button>)}
        <button
          type="button"
          onClick={() => setPreset('custom')}
          className={'px-3 py-1.5 rounded-full text-sm font-semibold border transition-colors ' +
            (preset === 'custom' ? 'bg-green-700 text-white border-green-700' : 'border-stone-200 text-stone-600 hover:border-stone-400')}>
          Custom
        </button>
        {data && <p className="text-xs muted ml-auto">
          {data.restaurant.name} · {data.range.from} → {data.range.to}
          {headline && <> · compared with {headline.previous_from} → {headline.previous_to}</>}
        </p>}
      </div>

      {preset === 'custom' && <form
        className="flex flex-wrap items-end gap-4 mt-4 pt-4 border-t border-stone-100"
        onSubmit={event => { event.preventDefault(); setApplied(custom) }}>
        <label className="text-sm">From
          <input type="date" className="field mt-1" value={custom.from}
            onChange={event => setCustom({ ...custom, from: event.target.value })} />
        </label>
        <label className="text-sm">To
          <input type="date" className="field mt-1" value={custom.to}
            onChange={event => setCustom({ ...custom, to: event.target.value })} />
        </label>
        <button className="btn-primary">Apply</button>
      </form>}
    </div>

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
          <p className="text-xs muted mt-1">{headline.review_count} review{headline.review_count === 1 ? '' : 's'} · lifetime</p>
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
