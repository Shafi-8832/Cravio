import { useState } from 'react'
import { editRestaurant } from '../services/ownerApi'
import { errorMessage } from '../utils/format'
export default function RestaurantSettings({ restaurant, onSaved }) {
  const [form, setForm] = useState({ name: restaurant.name, cuisine: restaurant.cuisine || 'Bangladeshi', description: restaurant.description || '', image_url: restaurant.image_url || '', image_credit: restaurant.image_credit || '', image_source_url: restaurant.image_source_url || '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { await editRestaurant(restaurant.id, form); await onSaved() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return <details className="surface p-5 mb-6"><summary className="font-bold cursor-pointer">🏪 Restaurant profile & cover photo</summary><form className="grid sm:grid-cols-2 gap-3 mt-5" onSubmit={save}>{error && <p className="notice-error sm:col-span-2">{error}</p>}{[['name', 'Restaurant name'], ['cuisine', 'Cuisine'], ['image_url', 'Photo URL (HTTPS or /media/filename.jpg)'], ['image_credit', 'Photographer / owner credit'], ['image_source_url', 'Photo source page (HTTPS)']].map(([key, label]) => <label key={key} className="text-sm">{label}<input className="field mt-1" required={key === 'name' || key === 'cuisine'} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}<label className="text-sm sm:col-span-2">Description<textarea className="field mt-1" maxLength={3000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><p className="text-xs muted sm:col-span-2">Use a photo you own or have permission to publish. Sample restaurants keep their demonstration label.</p><button disabled={busy} className="btn-primary justify-self-start">Save profile</button></form></details>
}
