import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../utils/api'
import FoodImage from '../components/FoodImage'
import { DIVISIONS, errorMessage } from '../utils/format'

export default function DirectoryPage() {
  const [enabled,setEnabled]=useState(null)
  const [city,setCity]=useState('Dhaka')
  const [area,setArea]=useState('')
  const [term,setTerm]=useState('')
  const [places,setPlaces]=useState([])
  const [cursor,setCursor]=useState(null)
  const [submitted,setSubmitted]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{api.get('/api/directory/config').then(r=>setEnabled(r.data.enabled)).catch(e=>setError(errorMessage(e)))},[])
  async function search(more=false) {
    setBusy(true);setError('')
    const filters=more ? submitted : {city,area:area.trim(),term:term.trim()}
    if(!more){setPlaces([]);setCursor(null);setSubmitted(filters)}
    try {
      const {data}=await api.get('/api/directory/search',{params:{...filters,...(more ? {cursor}: {})}})
      setPlaces(previous=>[...new Map([...(more?previous:[]),...data.places].map(p=>[p.place_id,p])).values()]);setCursor(data.cursor)
    } catch(e){setError(errorMessage(e))}
    finally {setBusy(false)}
  }
  return <main className="page-shell py-10">
    <Link to="/explore" className="text-sm muted">← Cravio restaurants</Link>
    <div className="hero-panel p-7 md:p-10 mt-5"><p className="eyebrow">Explore your city 🇧🇩</p><h1 className="hero-title !text-4xl mt-3">A whole city of flavours.</h1><p className="muted max-w-2xl mt-4">Discover real restaurants with live Google Maps listings and contributor photos. Restaurants here become available for Cravio checkout after they join as delivery partners.</p></div>
    <form className="surface p-5 mt-6 grid sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] gap-4 items-end" onSubmit={e=>{e.preventDefault();search()}}>
      <label className="text-sm font-semibold">City<select className="field mt-2" value={city} onChange={e=>setCity(e.target.value)}>{DIVISIONS.map(d=><option key={d}>{d}</option>)}</select></label>
      <label className="text-sm font-semibold">Neighborhood (optional)<input className="field mt-2" maxLength={80} value={area} onChange={e=>setArea(e.target.value)} placeholder="e.g. Dhanmondi" /></label>
      <label className="text-sm font-semibold">Food or restaurant<input className="field mt-2" maxLength={80} value={term} onChange={e=>setTerm(e.target.value)} placeholder="e.g. kacchi, burgers" /></label>
      <button className="btn-primary" disabled={busy || enabled !== true}>{busy?'Searching…':'📍 Find restaurants'}</button>
    </form>
    {enabled===false && <div className="surface p-6 mt-5"><h2 className="font-bold">Live city search is coming soon</h2><p className="text-sm muted mt-2">You can explore the sourced restaurant directory right now.</p><Link className="btn-primary mt-4" to="/explore">🍽️ Browse restaurants</Link></div>}
    {error && <p role="alert" className="notice-error mt-5">{error}</p>}
    {submitted && <div className="flex justify-between gap-5 items-center my-6"><p className="text-sm muted">{places.length} distinct listings loaded for {submitted.area ? submitted.area+', ' : ''}{submitted.city}. Search results are not an exhaustive restaurant census.</p><span translate="no" className="font-medium text-lg text-stone-600 whitespace-nowrap">Google Maps</span></div>}
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">{places.map(place=><article className="surface overflow-hidden" key={place.place_id}>
      <FoodImage src={place.photo?.url} alt={place.name+' — Google Maps contributor photo'} className="h-52 w-full object-cover" />
      <div className="p-5"><h2 className="font-extrabold text-lg">{place.name}</h2><p className="text-sm muted mt-2">{place.address}</p>{place.business_status && place.business_status !== 'OPERATIONAL' && <p className="text-sm text-amber-800 mt-2">{place.business_status.replaceAll('_',' ').toLowerCase()}</p>}
      <p className="text-xs muted mt-4">Photo: {place.photo?.authors?.length ? place.photo.authors.map((a,i)=><span key={i}>{i>0?', ':''}{a.url?<a href={a.url} target="_blank" rel="noreferrer" className="underline">{a.name}</a>:a.name}</span>) : place.photo?'Google Maps contributors':'Unavailable'}</p>
      {place.attributions.map((a,i)=><p className="text-xs muted mt-1" key={i}>{a.url?<a href={a.url} target="_blank" rel="noreferrer" className="underline">{a.name}</a>:a.name}</p>)}
      {place.google_maps_url && <a className="btn-secondary mt-4 w-full" href={place.google_maps_url} target="_blank" rel="noreferrer">View on Google Maps ↗</a>}</div>
    </article>)}</div>
    {submitted && !busy && !error && places.length===0 && <p className="surface p-8 text-center muted mt-6">No listings found. Try a broader food search or another neighborhood.</p>}
    {cursor && <button className="btn-primary mx-auto flex mt-7" disabled={busy} onClick={()=>search(true)}>{busy?'Loading…':'More restaurants ↓'}</button>}
    <p className="text-xs muted mt-7 leading-relaxed">Live search uses Google Maps. <a className="underline" href="https://maps.google.com/help/terms_maps/" target="_blank" rel="noreferrer">Google Maps terms</a> and <a className="underline" href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google privacy policy</a> apply. Searches are sent to Google; results and photos are displayed for this session. Contributor photos do not identify specific menu dishes.</p>
  </main>
}
