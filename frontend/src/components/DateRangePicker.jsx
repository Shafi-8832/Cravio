import { useState } from 'react'
import { PRESETS, rangeFor, defaultRange } from '../utils/dateRange'

// One range selector, shared by the owner and admin dashboards so the two
// behave identically and there is only one place to change it. It owns only
// the buttons: the chosen range is handed up through onApply, and whoever
// renders it decides what to fetch.
export default function DateRangePicker({ onApply, children }) {
  const [preset, setPreset] = useState('30')
  const [custom, setCustom] = useState(defaultRange)

  function choosePreset(item) {
    setPreset(item.key)
    const range = rangeFor(item.daysBack)
    setCustom(range)
    onApply(range)
  }

  return <div className="surface p-4 mb-5">
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
      {children}
    </div>

    {preset === 'custom' && <form
      className="flex flex-wrap items-end gap-4 mt-4 pt-4 border-t border-stone-100"
      onSubmit={event => { event.preventDefault(); onApply(custom) }}>
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
}

// A bar drawn with a div, so the dashboards need no charting library. The
// widest value in the list is 100% and everything else is measured against
// it — that comparison is presentation, not a statistic, and the numbers
// beside each bar are the ones the database computed.
export function Bar({ value, max }) {
  const width = max > 0 ? Math.max((Number(value) / max) * 100, value > 0 ? 2 : 0) : 0
  return <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
    <div className="h-full bg-green-700 rounded-full" style={{ width: width + '%' }} />
  </div>
}

// The percentage itself arrives already calculated by PostgreSQL. All this
// does is decide whether it is green or red and which arrow to draw. A null
// means the previous period had nothing to compare against.
export function Delta({ percent, previous }) {
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

export function Stat({ label, value, children }) {
  return <div className="surface p-4">
    <p className="text-xs muted uppercase tracking-wide">{label}</p>
    <p className="text-2xl font-extrabold mt-1">{value}</p>
    {children}
  </div>
}
