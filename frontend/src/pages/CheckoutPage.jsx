import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCart } from '../context/CartContext'
import { getRestaurant } from '../services/restaurantApi'
import { getAddresses } from '../services/accountApi'
import { getHealth, getPromos } from '../services/operationsApi'
import { placeOrder } from '../services/orderApi'
import FoodImage from '../components/FoodImage'
import LoadingSpinner from '../components/LoadingSpinner'
import { money, errorMessage } from '../utils/format'

export default function CheckoutPage() {
  const { restaurant, items, cartTotal, clearItems, loading: cartLoading } = useCart()
  const navigate = useNavigate()
  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [addresses, setAddresses] = useState([])
  const [addressId, setAddressId] = useState('')
  const [address, setAddress] = useState('')
  const [payment, setPayment] = useState('cash_on_delivery')
  const [manualEnabled, setManualEnabled] = useState(false)
  const [promos, setPromos] = useState([])
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    async function load() {
      if (!restaurant) { setLoading(false); return }
      try {
        const [details, saved, health, offers] = await Promise.all([getRestaurant(restaurant.id), getAddresses(), getHealth(), getPromos()])
        if (!active) return
        const open = details.data.restaurant.ordering_enabled ? details.data.restaurant.branches.filter(branch => branch.is_open) : []
        setBranches(open); setBranchId(String(open[0]?.id || ''))
        setAddresses(saved.data.addresses); setManualEnabled(health.data.manual_payments_enabled); setPromos(offers.data.promos)
        const preferred = saved.data.addresses.find(item => item.is_default)
        if (preferred) { setAddressId(String(preferred.id)); setAddress(formatAddress(preferred)) }
      } catch (err) { if (active) setError(errorMessage(err)) }
      finally { if (active) setLoading(false) }
    }
    load(); return () => { active = false }
  }, [restaurant])
  function formatAddress(item) { return [item.full_address, item.area, item.city, item.division, item.phone].filter(Boolean).join(', ') }
  const branch = branches.find(item => String(item.id) === branchId)
  const selectedAddress = addresses.find(item => String(item.id) === addressId)
  const mismatch = selectedAddress && branch && selectedAddress.division !== branch.division
  const fee = Number(branch?.delivery_fee || 0)
  const promo = promos.find(item => item.code === code.trim().toUpperCase() && cartTotal >= Number(item.min_order_amount))
  const discount = promo ? Math.round(cartTotal * Number(promo.discount_percent)) / 100 : 0
  const total = Math.max(0, cartTotal - discount) + fee
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await placeOrder({ branch_id: Number(branchId), delivery_address: address.trim(), payment_method: payment, promo_code: code.trim().toUpperCase() || undefined })
      // Checkout has committed. Do not show a false failure if a later cart refresh fails.
      clearItems()
      navigate('/orders', { state: { justPlacedOrderId: response.data.order.id } })
    } catch (err) { setError(errorMessage(err, 'Could not place your order.')) }
    finally { setBusy(false) }
  }
  if (loading || cartLoading) return <LoadingSpinner message="Getting your checkout ready…" />
  if (!restaurant || !items.length) return <main className="page-shell py-20 text-center"><p className="text-6xl">🛍️</p><h1 className="section-heading my-5">Your bag is empty</h1><Link className="btn-primary" to="/">Find something delicious</Link></main>
  return <main className="page-shell py-9"><Link to={'/restaurants/' + restaurant.id} className="muted text-sm">← Back to menu</Link><h1 className="section-heading my-6">One step closer to delicious.</h1>
    {error && <p role="alert" className="notice-error mb-5">{error}</p>}
    <form onSubmit={submit} className="grid lg:grid-cols-[1.3fr_1fr] gap-7 items-start">
      <div className="space-y-5">
        <section className="surface p-6"><h2 className="text-xl font-bold mb-5">📍 Where should we deliver?</h2><label className="field-label" htmlFor="branch">Restaurant branch</label><select required id="branch" className="field mb-4" value={branchId} onChange={event => setBranchId(event.target.value)}>{!branches.length && <option value="">No open branches</option>}{branches.map(item => <option key={item.id} value={item.id}>{item.area}, {item.city} · {item.division}</option>)}</select>
          {addresses.length > 0 && <><label className="field-label" htmlFor="saved-address">Saved address</label><select id="saved-address" className="field mb-4" value={addressId} onChange={event => { setAddressId(event.target.value); const item = addresses.find(value => String(value.id) === event.target.value); setAddress(item ? formatAddress(item) : '') }}><option value="">Use a different address</option>{addresses.map(item => <option key={item.id} value={item.id}>{item.label} · {item.area}, {item.city}</option>)}</select></>}
          <label className="field-label" htmlFor="delivery-address">Full address and contact number</label><textarea id="delivery-address" required minLength={5} maxLength={500} rows={4} className="field" placeholder="House, road, area, city, division and phone number" value={address} onChange={event => { setAddress(event.target.value); setAddressId('') }} />
          <Link to="/account" className="text-sm text-orange-700 inline-block mt-3">Manage saved addresses →</Link>
          {mismatch && <p className="notice-error mt-3">Choose a branch in the same division as your saved address.</p>}
          {branch && <p className="text-sm muted mt-3">Estimated delivery: {branch.eta_min}–{branch.eta_max} minutes. Nearby-restaurant routing is not enabled yet.</p>}
        </section>
        <section className="surface p-6"><h2 className="text-xl font-bold mb-4">💳 Payment</h2><label className="field-label" htmlFor="payment">Payment method</label><select id="payment" className="field" value={payment} onChange={event => setPayment(event.target.value)}><option value="cash_on_delivery">Cash on delivery</option>{manualEnabled && <><option value="bkash">bKash · manual verification</option><option value="nagad">Nagad · manual verification</option></>}</select>{payment !== 'cash_on_delivery' && <p className="notice-error mt-4">This is a manually verified payment record. Contact the restaurant for its verified merchant instructions; add your transaction reference in Orders. This app does not initiate a wallet charge.</p>}</section>
      </div>
      <section className="surface p-6 lg:sticky lg:top-24"><p className="eyebrow mb-2">Your order</p><h2 className="text-2xl font-extrabold mb-5">{restaurant.name}</h2>{items.map(item => <div key={item.cart_item_id} className="flex gap-3 mb-4"><FoodImage src={item.image_url} alt={item.name} className="w-14 h-14 rounded-lg object-cover shrink-0" /><div className="flex-1"><p className="font-semibold text-sm">{item.quantity} × {item.name}</p><p className="text-xs muted">{item.modifiers?.map(option => option.name).join(', ')}</p></div><span className="text-sm font-bold">{money(item.line_total)}</span></div>)}
        <label className="field-label mt-5" htmlFor="promo">🏷️ Promo code</label><input id="promo" className="field uppercase" maxLength={20} placeholder="Enter code" value={code} onChange={event => setCode(event.target.value)} />
        {promos.length > 0 && <div className="flex flex-wrap gap-2 mt-3">{promos.slice(0, 4).map(item => <button type="button" className="pill bg-orange-50 text-orange-800" key={item.id} onClick={() => setCode(item.code)}>{item.code}: {item.discount_percent}% · min {money(item.min_order_amount)}</button>)}</div>}
        {code && !promo && <p className="text-xs text-amber-800 mt-2">This code is not eligible for the current subtotal. The server will validate it when you place the order.</p>}
        <dl className="space-y-3 text-sm mt-6"><div className="flex justify-between"><dt>Subtotal</dt><dd>{money(cartTotal)}</dd></div><div className="flex justify-between"><dt>Delivery fee</dt><dd>{money(fee)}</dd></div>{discount > 0 && <div className="flex justify-between text-green-700"><dt>Estimated discount</dt><dd>−{money(discount)}</dd></div>}<div className="flex justify-between text-xl font-extrabold border-t pt-4"><dt>Estimated total</dt><dd>{money(total)}</dd></div></dl>
        {branch && cartTotal < Number(branch.min_order_amount) && <p className="notice-error mt-4">Minimum food subtotal: {money(branch.min_order_amount)}.</p>}
        <button disabled={busy || !branch || mismatch || cartTotal < Number(branch?.min_order_amount || 0)} className="btn-primary w-full mt-6">{busy ? 'Placing your order…' : '🍽️ Place order · ' + money(total)}</button><p className="text-xs muted mt-3">Prices and offers are checked again by the server. Final charges are shown in your order receipt.</p>
      </section>
    </form>
  </main>
}
