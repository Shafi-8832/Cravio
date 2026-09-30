import { useState } from 'react'
import { Link } from 'react-router-dom'
import { money } from '../utils/format'

const SOURCE_LABEL = { device: 'your current location', address: 'your saved address', pin: 'your delivery pin' }

// Shows which branch will deliver and lets the customer change it.
// All the deciding (distance, open/closed, can deliver) was already done in
// SQL by branches_by_distance(); this component only displays the rows the
// /branches endpoint returned, in the order it returned them.
export default function BranchSelector({ restaurant, user, locationStatus, location, branchCheck, branchError, selectedBranchId, onSelect, onRetryLocation }) {
  const [showList, setShowList] = useState(false)

  // Guests, owners, riders and admins do not order, so they get a plain,
  // read-only list of branches.
  if (user?.role !== 'customer') {
    return <section className="surface p-5 mt-5">
      <h2 className="text-lg font-extrabold mb-1">Branches</h2>
      {!user && <p className="text-sm muted mb-3"><Link to="/login" className="text-orange-700 underline">Log in</Link> as a customer and we will pick the nearest branch that delivers to you.</p>}
      <BranchInfoGrid branches={restaurant.branches} />
    </section>
  }

  if (branchError) {
    return <section className="surface p-5 mt-5"><p role="alert" className="notice-error">{branchError}</p></section>
  }

  // No location: say so, offer to try again, and let the customer pick any
  // open branch themselves. Checkout still checks the real delivery pin.
  if (locationStatus === 'unavailable') {
    return <section className="surface p-5 mt-5">
      <p className="notice-error mb-4">We could not get your location, so no branch was chosen automatically. Allow location access in your browser and <button type="button" className="underline font-bold" onClick={() => onRetryLocation()}>try again</button>, or pick a branch below and set your delivery pin at checkout.</p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {restaurant.branches.map(branch => {
          const selected = String(branch.id) === String(selectedBranchId)
          return <button key={branch.id} type="button" disabled={!branch.is_open} onClick={() => onSelect(branch.id)} className={'rounded-2xl border p-4 text-left transition disabled:opacity-50 ' + (selected ? 'border-orange-500 bg-orange-50' : 'border-stone-200 bg-white hover:border-stone-300')}>
            <div className="flex items-center justify-between gap-2 mb-1"><span className="font-bold text-sm">{branch.area}, {branch.city}</span>{!branch.is_open && <Badge>Closed</Badge>}</div>
            <p className="text-xs text-stone-500">{branch.address}</p>
          </button>
        })}
      </div>
    </section>
  }

  if (!branchCheck) {
    return <section className="surface p-5 mt-5"><p className="text-sm muted">📍 Finding the nearest branch that delivers to you…</p></section>
  }

  const selected = branchCheck.branches.find(branch => branch.branch_id === selectedBranchId && branch.can_deliver)
  const noneCanDeliver = branchCheck.selected_branch_id === null

  return <section className="surface p-5 mt-5">
    {selected && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="font-bold">🛵 Delivering from {selected.branch_name} · {selected.distance_km.toFixed(1)} km away</p>
      <button type="button" className="text-sm font-bold text-orange-700 underline" onClick={() => setShowList(!showList)}>{showList ? 'Close' : 'Change'}</button>
    </div>}
    {noneCanDeliver && <p className="notice-error">No branch of {restaurant.name} delivers to your location right now. You can still browse the menu.</p>}
    {!selected && !noneCanDeliver && <p className="notice-error">Choose a branch that delivers to you.</p>}
    {location && <p className="text-xs muted mt-1">Measured from {SOURCE_LABEL[location.source] || 'your location'}. Branches without a map location are not listed.</p>}

    {(showList || !selected) && <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
      {branchCheck.branches.map(branch => {
        const isSelected = branch.branch_id === selectedBranchId
        return <li key={branch.branch_id}>
          <button type="button" disabled={!branch.can_deliver} onClick={() => { onSelect(branch.branch_id); setShowList(false) }} className={'w-full rounded-2xl border p-4 text-left transition disabled:opacity-50 disabled:cursor-not-allowed ' + (isSelected ? 'border-orange-500 bg-orange-50' : 'border-stone-200 bg-white hover:border-stone-300')}>
            <div className="flex items-center justify-between gap-2 mb-1"><span className="font-bold text-sm">{branch.branch_name}</span><span className="text-sm font-bold text-orange-700">{branch.distance_km.toFixed(1)} km</span></div>
            <p className="text-xs text-stone-500">{branch.address}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              {!branch.is_open && <Badge>Closed</Badge>}
              {branch.is_open && !branch.can_deliver && <Badge>Out of delivery range · delivers within {branch.delivery_radius_km} km</Badge>}
            </div>
          </button>
        </li>
      })}
      {branchCheck.branches.length === 0 && <li className="text-sm muted">This restaurant has no branch on the map that takes orders.</li>}
    </ul>}
  </section>
}

function Badge({ children }) {
  return <span className="text-[10px] px-2 py-1 rounded-full bg-stone-200 text-stone-700">{children}</span>
}

// Read-only branch cards: area, address, open/closed, hours, fee.
function BranchInfoGrid({ branches }) {
  return <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
    {branches.map(branch => <div key={branch.id} className="rounded-2xl border border-stone-200 p-4">
      <div className="flex items-center justify-between gap-2 mb-1"><span className="font-bold text-sm">{branch.area}, {branch.city}</span>{!branch.is_open && <Badge>Closed</Badge>}</div>
      <p className="text-xs text-stone-500">{branch.address}</p>
      <p className="text-xs mt-2 text-stone-600">{branch.opens_at ? `${branch.opens_at.slice(0, 5)}–${branch.closes_at.slice(0, 5)}` : 'Open all day'} • {money(branch.delivery_fee)} delivery</p>
    </div>)}
  </div>
}
