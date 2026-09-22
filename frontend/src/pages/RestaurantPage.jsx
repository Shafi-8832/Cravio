import { useEffect, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useCart } from '../context/CartContext'
import { useAuth } from '../context/AuthContext'
import { getRestaurant, getRestaurantMenu, getRestaurantReviews } from '../services/restaurantApi'
import FoodImage from '../components/FoodImage'
import LoadingSpinner from '../components/LoadingSpinner'
import ModifierPicker from '../components/ModifierPicker'
import { money, errorMessage } from '../utils/format'

export default function RestaurantPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { addItem, fetchCart, itemCount, cartTotal } = useCart()
  const [restaurant, setRestaurant] = useState(null)
  const [menu, setMenu] = useState([])
  const [reviews, setReviews] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(null)
  const [query, setQuery] = useState('')
  const [selectedBranchId, setSelectedBranchId] = useState(null)
  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true); setError('')
      try {
        const [details, dishes, feedback] = await Promise.all([getRestaurant(id), getRestaurantMenu(id), getRestaurantReviews(id)])
        if (!active) return
        const dataRestaurant = details.data.restaurant
        setRestaurant(dataRestaurant)
        setMenu(dishes.data.categories)
        setReviews(feedback.data.reviews)
        setSelectedBranchId((dataRestaurant.branches && dataRestaurant.branches[0]?.id) || null)
        if (user?.role === 'customer') await fetchCart(id, { id: dataRestaurant.id, name: dataRestaurant.name })
      } catch (err) {
        // No local stand-in: the branch ids, prices and menu item ids this
        // page hands to the cart only mean anything in PostgreSQL, so a
        // made-up restaurant here would produce a cart nothing can order.
        if (active) { setRestaurant(null); setError(errorMessage(err, 'Could not load this restaurant.')) }
      }
      finally { if (active) setLoading(false) }
    }
    load(); return () => { active = false }
  }, [id, user?.role, fetchCart])
  const selectedBranch = restaurant?.branches?.find(branch => String(branch.id) === String(selectedBranchId)) || restaurant?.branches?.[0] || null
  async function add(item, modifiers) {
    if (!user) { navigate('/login'); return }
    if (!modifiers && item.modifier_groups?.length) { setPicker(item); return }
    setBusy(true); setError(''); setNotice('')
    try { await addItem(item, restaurant.id, modifiers || []); setPicker(null); setNotice(item.name + ' added to your bag.') }
    catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }
  if (loading) return <LoadingSpinner message="Finding something delicious…" />
  if (!restaurant) return <main className="page-shell py-12"><p className="notice-error">{error}</p><Link className="btn-secondary mt-5" to="/">Back to restaurants</Link></main>
  const orderable = restaurant.ordering_enabled && restaurant.branches.some(branch => branch.is_open)
  return <main className="page-shell py-7 pb-24">
    <Link to="/" className="text-sm muted">← All restaurants</Link>
    <section className="surface overflow-hidden mt-5 grid md:grid-cols-[1fr_1fr]">
      <FoodImage eager src={restaurant.image_url} alt={restaurant.name + (restaurant.image_is_illustrative ? ' — illustrative food photo' : '')} className="w-full h-64 md:h-80 object-cover" />
      <div className="p-7 md:p-10">{restaurant.logo_url && <FoodImage src={restaurant.logo_url} alt={restaurant.name + ' official logo'} className="w-20 h-20 object-contain rounded-xl bg-white border border-stone-100 mb-4" />}<p className="eyebrow mb-3">{restaurant.cuisine || 'Fresh from the kitchen'}</p><h1 className="text-3xl md:text-4xl font-extrabold">{restaurant.name}</h1><p className="text-sm muted mt-4 leading-relaxed">{restaurant.description}</p><p className="mt-4 font-semibold">⭐ {restaurant.average_rating ? Number(restaurant.average_rating).toFixed(1) + ' (' + restaurant.review_count + ' reviews)' : 'New · no reviews yet'}</p>
        {restaurant.is_demo && <p className="pill bg-orange-50 text-orange-800 mt-4">Sample restaurant · test orders only</p>}
        {!restaurant.ordering_enabled && <p className="notice-error mt-4">Directory listing. This restaurant is not accepting Cravio orders.</p>}
        {restaurant.image_is_illustrative && <p className="text-xs muted mt-3">Illustrative photo, not this restaurant’s actual food.</p>}
      </div>
    </section>

    <section className="surface p-5 mt-5">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
        <h2 className="text-lg font-extrabold">Choose your branch</h2>
        <span className="text-xs text-stone-500">Nearby location</span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {restaurant.branches.map(branch => {
          const selected = selectedBranch?.id === branch.id
          return <button key={branch.id} type="button" onClick={() => setSelectedBranchId(branch.id)} className={'rounded-2xl border p-4 text-left transition ' + (selected ? 'border-orange-500 bg-orange-50' : 'border-stone-200 bg-white hover:border-stone-300')}>
            <div className="flex items-center justify-between gap-2 mb-2"><span className="font-bold text-sm">{branch.area}</span><span className={'text-[10px] px-2 py-1 rounded-full ' + (branch.is_open ? 'bg-green-100 text-green-800' : 'bg-stone-200 text-stone-600')}>{branch.is_open ? 'Open' : 'Closed'}</span></div>
            <p className="text-xs text-stone-500">{branch.address}</p>
            <p className="text-xs mt-2 text-stone-600">{branch.eta_min}–{branch.eta_max} min • {money(branch.delivery_fee)} delivery</p>
          </button>
        })}
      </div>
    </section>

    {restaurant.source_url && <aside className="surface p-5 mt-5 text-sm"><a className="font-bold text-orange-700 underline" href={restaurant.source_url} target="_blank" rel="noreferrer">Official listing ↗</a><span className="muted ml-3">Source checked {restaurant.verified_at ? new Date(restaurant.verified_at).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : '—'}</span>{restaurant.menu_source_url && <p className="mt-3 muted">{restaurant.menu_scope === 'brand' ? 'Brand menu preview; prices and availability may vary by branch.' : 'Published branch menu snapshot; prices and availability may have changed.'} <a className="underline text-orange-700" href={restaurant.menu_source_url} target="_blank" rel="noreferrer">Check current menu ↗</a></p>}{restaurant.image_credit && <p className="text-xs muted mt-3">Photo: {restaurant.image_credit}. Published promotional images may differ from the served food.</p>}</aside>}
    {restaurant.gallery?.length > 0 && <section className="mt-6"><h2 className="text-xl font-bold mb-4">A look inside 📸</h2><div className="flex gap-4 overflow-x-auto pb-3">{restaurant.gallery.map((photo,index) => <figure key={photo.image_url + index} className="w-64 shrink-0"><FoodImage src={photo.image_url} alt={photo.caption} className="w-full h-48 rounded-xl object-cover" /><figcaption className="text-xs muted mt-2">{photo.caption} · {photo.image_credit}</figcaption></figure>)}</div></section>}
    <details className="surface p-5 mt-5"><summary className="font-bold cursor-pointer">📍 Selected branch: {selectedBranch ? `${selectedBranch.area}, ${selectedBranch.city}` : 'Choose a branch'}</summary><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">{restaurant.branches.map(branch => <div key={branch.id} className={'rounded-xl p-4 ' + (selectedBranch?.id === branch.id ? 'bg-orange-50' : 'bg-stone-50')}><p className="font-bold">{branch.area}, {branch.city}</p><p className="text-sm muted mt-1">{branch.address}</p><p className="text-sm mt-2">{branch.division} · {restaurant.ordering_enabled ? (branch.is_open ? 'Open' : 'Closed') : 'Check hours with the restaurant'}</p><p className="text-sm muted mt-1">{restaurant.ordering_enabled ? `${branch.eta_min}–${branch.eta_max} min · delivery ${money(branch.delivery_fee)}` : branch.phone || 'Delivery not available on Cravio'}</p></div>)}</div></details>
    <div className="flex flex-wrap items-center justify-between gap-4 mt-9 mb-5"><h2 className="section-heading">{restaurant.ordering_enabled ? 'On the menu 🍴' : 'Published menu preview 🍴'}</h2><input className="field !w-auto" placeholder="Search this menu…" aria-label="Search menu" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div aria-live="polite">{error && <p className="notice-error mb-4">{error}</p>}{notice && <p className="notice-success mb-4">{notice}</p>}</div>
    <nav aria-label="Menu categories" className="flex gap-2 overflow-x-auto pb-3 mb-5">{menu.map(category => <a className="btn-secondary whitespace-nowrap" key={category.id} href={'#category-' + category.id}>{category.name}</a>)}</nav>
    {menu.length === 0 && <p className="surface p-8 muted">A verified menu has not been added yet.</p>}
    {menu.map(category => {
      const dishes = category.items.filter(item => (item.name + ' ' + (item.description || '')).toLowerCase().includes(query.toLowerCase()))
      return dishes.length > 0 && <section id={'category-' + category.id} key={category.id} className="mb-8 scroll-mt-28"><h3 className="text-xl font-extrabold mb-4">{category.name}</h3><div className="grid md:grid-cols-2 gap-4">{dishes.map(item => <article key={item.id} className="surface p-4 flex gap-4">
        <div className="flex-1 min-w-0"><h4 className="font-bold text-lg">{item.name}</h4><p className="text-xs text-green-800 mt-1">{item.is_veg ? '🌱 Vegetarian' : ''}</p><p className="text-sm muted mt-2 line-clamp-2">{item.description}</p><p className="font-bold mt-3">{!restaurant.ordering_enabled && <span className="text-xs muted font-normal">Published from </span>}{money(item.price)}{item.modifier_groups?.length > 0 && <span className="text-xs muted font-normal"> · customise</span>}</p>{item.quality_flag && <p className="text-xs text-amber-800">Recent portion feedback is under review.</p>}</div>
        <div className="w-28 sm:w-36 shrink-0"><FoodImage src={item.image_url} alt={item.name + (item.image_is_illustrative ? ' — illustrative photo' : '')} className="w-full h-28 object-cover rounded-xl" />{item.image_is_illustrative && <p className="text-[11px] muted text-center mt-1">Illustrative photo</p>}{(!user || user.role === 'customer') && <button onClick={() => add(item)} disabled={busy || !item.is_available || !orderable} className="btn-primary !py-2 w-full mt-2">{!restaurant.ordering_enabled ? 'Preview only' : !item.is_available ? 'Sold out' : !orderable ? 'Closed' : '＋ Add'}</button>}</div>
      </article>)}</div></section>
    })}
    {query && !menu.some(category => category.items.some(item => (item.name + ' ' + (item.description || '')).toLowerCase().includes(query.toLowerCase()))) && <p className="surface p-8 muted">No dishes match that search.</p>}
    <section className="mt-10"><h2 className="section-heading mb-5">From the table</h2>{reviews.length ? <div className="grid md:grid-cols-2 gap-4">{reviews.map(review => <article className="surface p-5" key={review.id}><p className="font-bold">{'⭐'.repeat(review.rating)} <span className="text-sm muted">{review.customer_name}</span></p><p className="mt-3 text-sm">{review.comment || 'A rating from a delivered order.'}</p>
      {/* The owner's answer sits under the review it answers, clearly labelled
          so nobody mistakes the restaurant's words for the diner's. */}
      {review.owner_reply && <div className="mt-4 pl-4 border-l-2 border-orange-300">
        <p className="text-xs font-bold text-orange-700">Reply from {restaurant.name}{review.owner_replied_at && <span className="muted font-normal"> · {new Date(review.owner_replied_at).toLocaleDateString()}</span>}</p>
        <p className="text-sm mt-1">{review.owner_reply}</p>
      </div>}</article>)}</div> : <p className="muted text-sm">{restaurant.ordering_enabled ? 'Be the first to review after your order is delivered.' : 'No Cravio delivery reviews yet.'}</p>}</section>
    {user?.role === 'customer' && itemCount > 0 && <div className="fixed bottom-5 inset-x-5 z-20 max-w-md mx-auto"><Link to="/checkout" className="btn-primary w-full shadow-xl !py-4"><span>🛍️ {itemCount} items · View checkout</span><span className="ml-auto">{money(cartTotal)}</span></Link></div>}
    {picker && <ModifierPicker item={picker} onCancel={() => setPicker(null)} onConfirm={ids => add(picker, ids)} />}
  </main>
}
