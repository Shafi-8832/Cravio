import { useCallback, useEffect, useState } from 'react'
import { getOrderDetails, cancelOrder, reviewOrder, reviewRider, submitPaymentReference, verifyPayment } from '../services/orderApi'
import { useAuth } from '../context/AuthContext'
import FoodImage from './FoodImage'
import StarInput from './StarInput'
import { money, errorMessage } from '../utils/format'

const steps = ['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered']
export default function OrderReceipt({ id, onChanged }) {
  const { user } = useAuth()
  const [order, setOrder] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [reference, setReference] = useState('')
  // Both ratings start at 0 — unset. A pre-filled 5 would publish a score the
  // customer never actually chose, so the submit button stays disabled until
  // a star is tapped.
  const [review, setReview] = useState({ rating: 0, portion_accuracy: 'full', comment: '' })
  const [reviewed, setReviewed] = useState(false)
  const [riderReview, setRiderReview] = useState({ rating: 0, comment: '' })
  const [riderReviewed, setRiderReviewed] = useState(false)
  const load = useCallback(async () => {
    try { setOrder((await getOrderDetails(id)).data.order) }
    catch (err) { setError(errorMessage(err)) }
  }, [id])
  // The effect starts remote I/O; load updates state after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => clearInterval(timer) }, [load])
  async function action(operation, message) {
    setBusy(true); setError(''); setNotice('')
    try { await operation(); setNotice(message); await load(); onChanged?.() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  if (!order) return <div className="p-5">{error ? <p className="notice-error">{error}<button onClick={load} className="underline ml-2">Retry</button></p> : <p className="muted">Loading receipt…</p>}</div>
  const customer = user.role === 'customer'
  const mobile = order.payment && order.payment.method !== 'cash_on_delivery'
  const current = steps.indexOf(order.status)
  return <div className="p-5 bg-stone-50 rounded-b-2xl">
    {error && <p className="notice-error mb-3" role="alert">{error}</p>}{notice && <p className="notice-success mb-3" role="status">{notice}</p>}
    {order.status !== 'cancelled' && <ol className="flex mb-7">{steps.map((step, index) => <li key={step} className={'order-step ' + (index < current ? 'complete' : '')}><span className={'w-9 h-9 relative z-10 rounded-full mx-auto flex items-center justify-center text-sm font-bold ' + (index <= current ? 'bg-green-800 text-white' : 'bg-stone-200 text-stone-500')}>{index < current ? '✓' : index + 1}</span><span className="block text-[11px] sm:text-xs mt-2 capitalize">{step.replaceAll('_', ' ')}</span></li>)}</ol>}
    <p className="text-sm mb-4"><strong>Deliver to:</strong> {order.delivery_address}</p>
    <div className="space-y-3">{order.items.map(item => <div key={item.id} className="flex gap-3 items-center"><FoodImage src={item.image_url} alt={item.name} className="w-14 h-14 object-cover rounded-lg" /><div className="flex-1"><p className="text-sm font-semibold">{item.quantity} × {item.name}</p><p className="text-xs muted">{item.modifiers?.map(modifier => modifier.name).join(', ')}</p></div><p className="text-sm font-bold">{money(item.line_total)}</p></div>)}</div>
    <dl className="text-sm space-y-2 mt-5 border-t pt-4">{[['Subtotal', order.subtotal], ['Discount', -Number(order.discount_amount)], ['Delivery', order.delivery_fee], ['Total', order.total_amount]].map(([label, amount]) => <div className="flex justify-between" key={label}><dt>{label}</dt><dd className="font-bold">{money(amount)}</dd></div>)}</dl>
    <p className="text-sm mt-4">Payment: {order.payment?.method.replaceAll('_', ' ')} · <strong>{order.payment?.status}</strong>{order.payment?.transaction_ref && ' · Reference: ' + order.payment.transaction_ref}</p>
    {order.delivery && <p className="text-sm mt-2">🚴 {order.delivery.rider_name} · {order.delivery.delivery_status.replaceAll('_', ' ')} {order.delivery.rider_phone && <a href={'tel:' + order.delivery.rider_phone} className="text-orange-700 underline">{order.delivery.rider_phone}</a>}</p>}
    <details className="mt-4 text-sm"><summary className="cursor-pointer font-semibold">Order timeline · refreshes every 15 seconds</summary><ol className="mt-3 space-y-2">{order.timeline?.map((event, index) => <li key={index} className="capitalize">{event.status.replaceAll('_', ' ')} · {new Date(event.created_at).toLocaleString()}{event.note && <span className="block muted text-xs normal-case">{event.note}</span>}</li>)}</ol></details>
    {customer && ['pending', 'confirmed'].includes(order.status) && <button disabled={busy} className="btn-secondary mt-4 !text-red-700" onClick={() => action(() => cancelOrder(order.id), 'Order cancelled.')}>Cancel order</button>}
    {customer && mobile && order.payment.status === 'unpaid' && order.status !== 'cancelled' && <form onSubmit={event => { event.preventDefault(); action(() => submitPaymentReference(order.id, reference), 'Reference submitted for manual verification.') }} className="mt-4"><label className="field-label">Wallet transaction reference<input required maxLength={100} className="field mt-2" value={reference} onChange={event => setReference(event.target.value)} /></label><button className="btn-secondary" disabled={busy}>Submit reference</button></form>}
    {!customer && ['admin', 'restaurant_owner'].includes(user.role) && mobile && order.payment.status === 'unpaid' && order.status !== 'cancelled' && <div className="mt-4"><p className="text-sm muted mb-3">Verify the reference and amount in your merchant account before confirming receipt.</p><button disabled={busy || !order.payment.transaction_ref} className="btn-primary" onClick={() => action(() => verifyPayment(order.id), 'Payment marked received after your verification.')}>Confirm payment received</button></div>}
    {customer && order.status === 'delivered' && order.review_eligible && !reviewed && <form className="mt-6 border-t pt-5" onSubmit={event => { event.preventDefault(); action(async () => { await reviewOrder(order.id, review); setReviewed(true) }, 'Thank you! Your review has been published.') }}><h3 className="font-bold text-lg mb-3">How was your meal? 😋</h3><div className="grid sm:grid-cols-2 gap-3"><StarInput label="Rating" value={review.rating} onChange={rating => setReview({ ...review, rating })} /><label className="text-sm">Portion size<select className="field mt-1" value={review.portion_accuracy} onChange={event => setReview({ ...review, portion_accuracy: event.target.value })}><option value="full">As expected</option><option value="slightly_less">Slightly less</option><option value="way_less">Much less</option></select></label></div><label className="field-label mt-3">Your feedback<textarea className="field mt-1" maxLength={1000} value={review.comment} onChange={event => setReview({ ...review, comment: event.target.value })} /></label><button disabled={busy || !review.rating} className="btn-primary mt-2">⭐ Submit review</button></form>}
    {/* Rating the rider is a separate submission from rating the meal: the food can be
        great and the delivery awful. It is offered only once a rider is actually
        recorded on the order, and hides once rider_reviewed comes back true — the
        server rejects a second one either way (409 ALREADY_REVIEWED). What is written
        here is never shown back to the rider or to the restaurant; only the admin
        panel can read it. */}
    {customer && order.status === 'delivered' && order.review_eligible && order.delivery?.rider_id && !order.rider_reviewed && !riderReviewed && <form className="mt-6 border-t pt-5" onSubmit={event => { event.preventDefault(); action(async () => { await reviewRider(order.id, riderReview); setRiderReviewed(true) }, 'Thanks — your rider feedback went to the Cravio team.') }}><h3 className="font-bold text-lg mb-1">How was your rider? 🛵</h3><p className="text-sm muted mb-3">Rating {order.delivery.rider_name}. Only the Cravio team sees this — your rider and the restaurant never do.</p><StarInput label="Delivery rating" value={riderReview.rating} onChange={rating => setRiderReview({ ...riderReview, rating })} /><label className="field-label mt-3">Anything to add? (optional)<textarea className="field mt-1" maxLength={1000} placeholder="On time, polite, food arrived hot…" value={riderReview.comment} onChange={event => setRiderReview({ ...riderReview, comment: event.target.value })} /></label><button disabled={busy || !riderReview.rating} className="btn-primary mt-2">🛵 Submit rider rating</button></form>}

    {customer && order.rider_reviewed && <p className="text-sm muted mt-4">🛵 You have already rated this delivery. Thank you.</p>}
  </div>
}
