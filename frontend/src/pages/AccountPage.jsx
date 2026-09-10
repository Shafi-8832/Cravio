import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getAddresses, createAddress, updateAddress, deleteAddress, getFavorites, removeFavorite, updateProfile } from '../services/accountApi'
import RestaurantCard from '../components/RestaurantCard'
import SupportPanel from '../components/SupportPanel'
import { DIVISIONS, errorMessage } from '../utils/format'

const emptyAddress = { label: 'Home', full_address: '', area: '', city: '', division: 'Dhaka', phone: '', is_default: false }
export default function AccountPage() {
  const { user, refreshUser, logout } = useAuth()
  const [profile, setProfile] = useState({ name: user.name, phone: user.phone || '' })
  const [addresses, setAddresses] = useState([])
  const [favorites, setFavorites] = useState([])
  const [form, setForm] = useState(emptyAddress)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (user.role !== 'customer') return
    Promise.all([getAddresses(), getFavorites()]).then(([a, f]) => { setAddresses(a.data.addresses); setFavorites(f.data.restaurants) })
      .catch(err => setError(errorMessage(err)))
  }, [user.role])
  async function saveProfile(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { refreshUser((await updateProfile(profile)).data.user); setNotice('Your profile has been updated.') }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  async function saveAddress(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { await (editing ? updateAddress(editing, form) : createAddress(form)); setAddresses((await getAddresses()).data.addresses); setForm(emptyAddress); setEditing(null); setNotice('Address saved.') }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  async function removeAddress(id) {
    setError('')
    try { await deleteAddress(id); setAddresses(addresses.filter(item => item.id !== id)) }
    catch (err) { setError(errorMessage(err)) }
  }
  async function unfavorite(id) {
    try { await removeFavorite(id); setFavorites(favorites.filter(item => item.id !== id)) }
    catch (err) { setError(errorMessage(err)) }
  }
  return <main className="page-shell py-9"><div className="dashboard-heading flex justify-between items-center gap-3"><div><p className="eyebrow mb-2">Your little corner</p><h1 className="section-heading">Hello, {user.name.split(' ')[0]} 👋</h1><p className="text-sm muted mt-2">{user.email} · {user.role.replaceAll('_', ' ')}</p></div><button className="btn-secondary" onClick={() => logout().catch(err => setError(errorMessage(err)))}>Sign out</button></div>
    {error && <p className="notice-error mb-4" role="alert">{error}</p>}{notice && <p className="notice-success mb-4" role="status">{notice}</p>}
    <form onSubmit={saveProfile} className="surface p-6 grid sm:grid-cols-2 gap-4"><h2 className="font-bold text-xl sm:col-span-2">Your profile</h2><label className="text-sm">Name<input className="field mt-1" value={profile.name} required maxLength={100} onChange={event => setProfile({ ...profile, name: event.target.value })} /></label><label className="text-sm">Phone<input className="field mt-1" type="tel" required maxLength={20} value={profile.phone} onChange={event => setProfile({ ...profile, phone: event.target.value })} /></label><button disabled={busy} className="btn-primary justify-self-start">Save profile</button></form>
    {user.role === 'customer' && <>
      <section className="surface p-6 mt-6"><h2 className="text-xl font-bold mb-5">📍 Saved addresses</h2><div className="grid md:grid-cols-2 gap-4">{addresses.map(item => <article key={item.id} className="rounded-xl border border-stone-200 p-4"><p className="font-bold">{item.label} {item.is_default && <span className="pill bg-green-50 text-green-800">Default</span>}</p><p className="text-sm mt-2">{item.full_address}</p><p className="text-sm muted">{item.area}, {item.city} · {item.division}</p><p className="text-sm muted">{item.phone}</p><div className="flex gap-4 mt-3"><button className="text-sm text-orange-700" onClick={() => { setForm({ ...emptyAddress, ...item, phone: item.phone || '' }); setEditing(item.id) }}>Edit</button><button className="text-sm text-red-600" onClick={() => removeAddress(item.id)}>Remove</button></div></article>)}</div>
        <form onSubmit={saveAddress} className="grid sm:grid-cols-2 gap-3 mt-6"><h3 className="font-bold sm:col-span-2">{editing ? 'Edit address' : 'Add an address'}</h3><label className="text-sm">Label<select className="field mt-1" value={form.label} onChange={event => setForm({ ...form, label: event.target.value })}>{['Home', 'Work', 'Other'].map(item => <option key={item}>{item}</option>)}</select></label><label className="text-sm">Division<select className="field mt-1" value={form.division} onChange={event => setForm({ ...form, division: event.target.value })}>{DIVISIONS.map(item => <option key={item}>{item}</option>)}</select></label>
          {['city', 'area', 'phone'].map(field => <label key={field} className="text-sm capitalize">{field}<input className="field mt-1" type={field === 'phone' ? 'tel' : 'text'} required maxLength={field === 'phone' ? 20 : 100} value={form[field]} onChange={event => setForm({ ...form, [field]: event.target.value })} /></label>)}<label className="text-sm sm:col-span-2">Full address<textarea required minLength={5} maxLength={500} className="field mt-1" value={form.full_address} onChange={event => setForm({ ...form, full_address: event.target.value })} /></label><label className="text-sm flex gap-2 items-center"><input type="checkbox" checked={form.is_default} onChange={event => setForm({ ...form, is_default: event.target.checked })} />Make this my default</label><div className="flex justify-end gap-3">{editing && <button className="btn-secondary" type="button" onClick={() => { setEditing(null); setForm(emptyAddress) }}>Cancel</button>}<button disabled={busy} className="btn-primary">Save address</button></div></form>
      </section>
      <section className="mt-8"><h2 className="section-heading mb-5">Your favourites ❤️</h2>{favorites.length ? <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">{favorites.map(item => <RestaurantCard key={item.id} restaurant={item} favorite onFavorite={unfavorite} />)}</div> : <p className="muted text-sm">Tap a restaurant’s heart to save it here.</p>}</section>
    </>}
    <SupportPanel admin={user.role === 'admin'} />
  </main>
}
