import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import RestaurantCard from '../components/RestaurantCard'
import Icon from '../components/Icon'
import FoodImage from '../components/FoodImage'
import { listRestaurants } from '../services/restaurantApi'
import { getFavorites, saveFavorite, removeFavorite } from '../services/accountApi'
import { useAuth } from '../context/AuthContext'
import { DIVISIONS, errorMessage, foodPhotos } from '../utils/format'

const categories = [
  ['🍽️', 'All food', ''], ['🍛', 'Biryani', 'biryani'], ['🍔', 'Burgers', 'burger'],
  ['🍕', 'Pizza', 'pizza'], ['🍜', 'Noodles', 'noodles'], ['🥗', 'Healthy', 'healthy'],
  ['🍗', 'Chicken', 'chicken'], ['☕', 'Café & tea', 'cafe'],
]
export default function HomePage() {
  const { user } = useAuth()
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [division, setDivision] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [cuisine, setCuisine] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const [sort, setSort] = useState('recommended')
  const [favorites, setFavorites] = useState([])
  const filterKey = JSON.stringify([division, query, cuisine, openOnly, sort])
  const [paging, setPaging] = useState({ key: '', page: 1 })
  const page = paging.key === filterKey ? paging.page : 1
  const [total, setTotal] = useState(0)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true); setError('')
      try {
        const response = await listRestaurants({ division: division || undefined, search: query || undefined, cuisine: cuisine || undefined, page, limit: 24, sort, open_only: String(openOnly) })
        // The database is the only catalogue. A card must carry the same id
        // the detail page will look up, so nothing is substituted here —
        // a local stand-in list would send /restaurants/3 to whichever
        // restaurant happens to be id 3 in PostgreSQL.
        const result = response?.data?.restaurants || []
        if (active) {
          setRestaurants(result)
          setTotal(response?.data?.pagination?.total || result.length)
        }
      } catch (err) {
        if (active) {
          setRestaurants([])
          setTotal(0)
          setError(errorMessage(err, 'Could not load restaurants.'))
        }
      }
      finally { if (active) setLoading(false) }
    }
    load()
    return () => { active = false }
  }, [division, query, cuisine, retry, page, sort, openOnly])
  useEffect(() => {
    if (user?.role !== 'customer') return
    getFavorites().then(response => setFavorites(response.data.restaurants.map(item => item.id)))
      .catch(err => setError(errorMessage(err, 'Could not load your favourites.')))
  }, [user?.id, user?.role])
  async function toggleFavorite(id, saved) {
    try {
      await (saved ? removeFavorite(id) : saveFavorite(id))
      setFavorites(previous => saved ? previous.filter(item => item !== id) : [...previous, id])
    } catch (err) { setError(errorMessage(err)) }
  }
  const shown = restaurants
  const discover = () => document.getElementById('restaurants').scrollIntoView({ behavior: 'smooth' })
  return <main className="page-shell pt-7 pb-12">
    <section className="hero-panel grid md:grid-cols-[1.12fr_1fr] min-h-[415px]">
      <div className="px-7 py-10 md:px-12 md:py-12 relative z-10">
        <p className="eyebrow flex items-center gap-2 mb-5"><span className="w-5 h-px bg-orange-600" />Good food. Good mood.</p>
        <h1 className="hero-title">Your cravings,<br /><span className="text-orange-600">delivered.</span></h1>
        <p className="text-stone-600 text-sm md:text-base max-w-sm leading-relaxed mt-5">From a comforting plate of biryani to your favourite burger. Find your next happy bite.</p>
        <button onClick={discover} className="btn-primary mt-7 !px-6">Find my food <Icon name="arrow" size={18} /></button>
        <p className="text-xs text-green-900/70 mt-5 flex items-center gap-2"><span>🇧🇩</span> Discover flavours across all 8 divisions</p>
      </div>
      <div className="relative min-h-[290px] md:min-h-[420px] flex items-center justify-center pb-8 md:pb-0">
        <div className="absolute w-[460px] h-[460px] rounded-full border border-green-900/10" />
        <div className="absolute w-[540px] h-[540px] rounded-full border border-green-900/5" />
        <FoodImage src={foodPhotos.hero} alt="Fresh burger — illustrative food photography" className="hero-photo relative -rotate-6" eager />
        <span aria-hidden="true" className="float-food absolute text-5xl top-2 left-4 md:top-8 md:left-8">🌶️</span>
        <span aria-hidden="true" className="float-food absolute text-5xl right-5 top-14">🥬</span>
        <span aria-hidden="true" className="float-food absolute text-4xl bottom-7 right-12">🍟</span>
        <div className="absolute bottom-9 left-7 md:bottom-10 md:left-0 bg-white rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 -rotate-3"><span className="text-2xl">😋</span><div><p className="text-xs font-extrabold">A little joy in every order</p><p className="text-[10px] text-stone-500 mt-1">Made for your food mood</p></div></div>
      </div>
    </section>

    <section className="mt-10" aria-label="Food categories">
      <div className="flex justify-between items-center mb-5"><h2 className="section-heading !text-2xl">What sounds good?</h2><span className="hidden sm:inline text-xs text-stone-500">Follow your cravings ✨</span></div>
      <div className="category-scroll grid grid-flow-col auto-cols-[91px] md:auto-cols-auto md:grid-flow-row md:grid-cols-8 gap-3 overflow-x-auto pb-2">
        {categories.map(([emoji, label, value]) => <button key={label} onClick={() => { setCuisine(value); discover() }} aria-pressed={cuisine === value} className={'rounded-2xl px-2 py-4 border text-center transition-colors ' + (cuisine === value ? 'bg-orange-50 border-orange-300 text-orange-700' : 'bg-white border-stone-200/70 hover:border-orange-300')}><span className="block text-3xl mb-2" aria-hidden="true">{emoji}</span><span className="font-semibold text-xs">{label}</span></button>)}
      </div>
    </section>

    <div className="grid sm:grid-cols-2 gap-5 mt-7">
      <button onClick={() => { setCuisine('biryani'); discover() }} className="promo-card rounded-2xl bg-[#fbe7d5] p-6 text-left flex items-center"><div className="relative z-10 max-w-[65%]"><p className="eyebrow !text-[10px] mb-2">The comfort collection</p><h3 className="text-xl font-extrabold">Big flavour.<br />Bigger biryani love.</h3><span className="text-xs font-semibold inline-flex items-center gap-1 mt-3">Explore biryani <Icon name="arrow" size={14} /></span></div><span className="text-8xl absolute right-4 -rotate-12" aria-hidden="true">🍛</span></button>
      <button onClick={() => { setCuisine(''); setDivision('Dhaka'); discover() }} className="promo-card rounded-2xl bg-[#e8edde] p-6 text-left flex items-center"><div className="relative z-10 max-w-[65%]"><p className="eyebrow !text-[10px] !text-green-800 mb-2">Across all 8 divisions</p><h3 className="text-xl font-extrabold">Local favourites,<br />near your area.</h3><span className="text-xs font-semibold inline-flex items-center gap-1 mt-3">Discover Dhaka <Icon name="arrow" size={14} /></span></div><span className="text-8xl absolute right-5 rotate-12" aria-hidden="true">🥘</span></button>
    </div>

    <section id="restaurants" className="mt-11 scroll-mt-28">
      <div className="flex items-end justify-between gap-4 mb-5"><div><p className="eyebrow mb-2">Find your next favourite</p><h2 className="section-heading">Restaurants to love</h2></div><span className="text-xs text-stone-500 hidden sm:inline">{loading ? 'Finding good food…' : total + ' restaurants to explore'}</span></div>
      <div className="surface p-3 flex flex-wrap gap-3 items-center mb-4">
        <label className="flex items-center gap-2 border-r border-stone-200 pr-3"><Icon name="pin" size={18} className="text-orange-600" /><span className="sr-only">Division</span><select className="bg-transparent text-sm font-semibold max-w-[155px] py-2" value={division} onChange={event => setDivision(event.target.value)}><option value="">All divisions</option>{DIVISIONS.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="flex items-center gap-2 flex-1 min-w-[170px]"><Icon name="search" size={18} className="text-stone-400" /><span className="sr-only">Search restaurants or cuisine</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search restaurants or cuisine…" className="bg-transparent text-sm w-full py-2 outline-none" /></label>
        <label className="text-xs text-stone-500 flex items-center gap-2"><span>Sort by</span><select value={sort} onChange={event => setSort(event.target.value)} className="text-green-950 bg-stone-50 rounded-lg p-2 font-semibold"><option value="recommended">Recommended</option><option value="rating">Top rated</option><option value="name">Name A–Z</option></select></label>
      </div>
      <div className="flex gap-2 flex-wrap items-center mb-6"><button onClick={() => setOpenOnly(!openOnly)} aria-pressed={openOnly} className={'pill border ' + (openOnly ? 'bg-green-900 text-white border-green-900' : 'bg-white border-stone-200 text-stone-600')}>🟢 Open now</button>{(division || cuisine || search) && <button className="pill bg-orange-50 text-orange-700" onClick={() => { setDivision(''); setCuisine(''); setSearch(''); setOpenOnly(false) }}>Clear filters ×</button>}<Link to="/directory" className="text-xs text-orange-700 font-bold ml-auto">📍 Search more real restaurants →</Link></div>
      {error && <div className="notice-error mb-5" role="alert">{error}<button onClick={() => setRetry(value => value + 1)} className="font-bold underline ml-3">Try again</button></div>}
      {loading ? <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5" aria-label="Loading restaurants">{[1, 2, 3, 4].map(item => <div key={item} className="surface h-[330px] animate-pulse"><div className="h-[200px] bg-stone-200/70 rounded-t-2xl" /><div className="h-5 bg-stone-100 m-5 rounded-lg" /><div className="h-3 bg-stone-100 mx-5 rounded-lg w-1/2" /></div>)}</div>
        : shown.length > 0 ? <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">{shown.map(restaurant => <RestaurantCard key={restaurant.id} restaurant={restaurant} favorite={favorites.includes(restaurant.id)} onFavorite={user?.role === 'customer' ? toggleFavorite : undefined} />)}</div>
        : !error && <div className="surface text-center p-12"><p className="text-5xl mb-4">🍽️</p><h3 className="text-xl font-bold">No restaurants here yet</h3><p className="text-stone-500 text-sm mt-2">Try another division or clear your filters. Restaurants appear once added to the catalogue.</p></div>}
      {!loading && total > 24 && <nav aria-label="Restaurant pages" className="flex items-center justify-center gap-4 mt-7"><button className="btn-secondary" disabled={page === 1} onClick={() => setPaging({ key: filterKey, page: page - 1 })}>← Previous</button><span className="text-sm">Page {page} of {Math.ceil(total / 24)}</span><button className="btn-secondary" disabled={page * 24 >= total} onClick={() => setPaging({ key: filterKey, page: page + 1 })}>Next →</button></nav>}
      {!loading && shown.length > 0 && <p className="text-xs text-stone-500 leading-relaxed mt-5">Menus, prices and photographs are snapshots of each brand's published sources, linked on the restaurant page. Orders placed here are coursework tests and reach no real restaurant.</p>}
    </section>
    <section className="rounded-2xl bg-green-950 text-white p-7 md:p-9 mt-12 flex items-center justify-between gap-6 flex-wrap"><div><p className="text-orange-300 text-xs tracking-widest font-bold uppercase mb-2">A seat at our table</p><h2 className="text-2xl md:text-3xl font-extrabold">Great food starts with great people.</h2><p className="text-green-100/70 text-sm mt-3">Bring your restaurant to Cravio, or join the delivery team.</p></div><Link to="/signup" className="btn-primary">Join the community <Icon name="arrow" size={18} /></Link></section>
  </main>
}
