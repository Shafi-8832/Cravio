import { useState } from 'react'
import Modal from './Modal'
import { editMenuItem, addModifierGroup, addModifierOption, toggleModifierOption, deleteModifierGroup, getMenu } from '../services/ownerApi'
import { money, errorMessage } from '../utils/format'
function OptionForm({ group, act }) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('0')
  return <form className="flex flex-wrap gap-2 mt-3" onSubmit={event => { event.preventDefault(); act(async () => { await addModifierOption(group.id, { name, price_modifier: Number(price) }); setName(''); setPrice('0') }) }}><input required aria-label="Option name" maxLength={100} className="field flex-1 min-w-[130px]" placeholder="Option name" value={name} onChange={event => setName(event.target.value)} /><input required aria-label="Extra price" type="number" step="0.01" className="field !w-24" value={price} onChange={event => setPrice(event.target.value)} /><button className="btn-secondary">Add option</button></form>
}
export default function OwnerItemEditor({ item, restaurantId, onClose, onSaved }) {
  const [form, setForm] = useState({ name: item.name, price: item.price, description: item.description || '', image_url: item.image_url || '', is_veg: item.is_veg })
  const [groups, setGroups] = useState(item.modifier_groups || [])
  const [groupForm, setGroupForm] = useState({ name: '', is_required: false, min_selection: 0, max_selection: 1 })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function act(operation) {
    setBusy(true); setError(''); setNotice('')
    try {
      await operation()
      const menu = (await getMenu(restaurantId)).data.categories.flatMap(category => category.items)
      setGroups(menu.find(row => row.id === item.id)?.modifier_groups || [])
      await onSaved(); setNotice('Changes saved.')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return <Modal label={'Edit ' + item.name} onClose={onClose}><div className="p-6"><div className="flex justify-between gap-3 mb-4"><h2 className="text-xl font-bold">Edit menu item</h2><button className="icon-button" onClick={onClose} aria-label="Close editor">×</button></div>{error && <p className="notice-error mb-3">{error}</p>}{notice && <p className="notice-success mb-3">{notice}</p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); act(() => editMenuItem(item.id, { ...form, price: Number(form.price) })) }}>{[['name', 'Name', 'text'], ['price', 'Price (BDT)', 'number'], ['image_url', 'Photo URL', 'text']].map(([key, label, type]) => <label key={key} className="field-label">{label}<input className="field mt-1" required={key !== 'image_url'} type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? '0.01' : undefined} maxLength={key === 'name' ? 100 : 255} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}<label className="field-label">Description<textarea className="field mt-1" maxLength={2000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><label className="text-sm flex gap-2"><input type="checkbox" checked={form.is_veg} onChange={event => setForm({ ...form, is_veg: event.target.checked })} />Vegetarian</label><button className="btn-primary" disabled={busy}>Save item</button></form>
    <h3 className="text-lg font-bold mt-7 mb-3">Customisations & extras</h3>{groups.map(group => <section key={group.id} className="border rounded-xl p-4 mb-3"><div className="flex justify-between"><strong>{group.name}</strong><button disabled={busy} className="text-xs text-red-700" onClick={() => act(() => deleteModifierGroup(group.id))}>Remove group</button></div><p className="text-xs muted mt-1">{group.is_required ? 'Required' : 'Optional'} · choose {group.min_selection}–{group.max_selection}</p>{group.options.map(option => <div key={option.id} className="flex justify-between text-sm mt-3"><span>{option.name} · {money(option.price_modifier)}</span><button disabled={busy} className="text-orange-700" onClick={() => act(() => toggleModifierOption(option.id))}>{option.is_available ? 'Available' : 'Unavailable'}</button></div>)}<OptionForm group={group} act={act} /></section>)}
    <form className="space-y-3 bg-stone-50 rounded-xl p-4" onSubmit={event => { event.preventDefault(); act(async () => { await addModifierGroup(item.id, { ...groupForm, min_selection: Number(groupForm.min_selection), max_selection: Number(groupForm.max_selection) }); setGroupForm({ name: '', is_required: false, min_selection: 0, max_selection: 1 }) }) }}><label className="field-label">New option group<input className="field mt-1" placeholder="Size, toppings, spice level…" required maxLength={100} value={groupForm.name} onChange={event => setGroupForm({ ...groupForm, name: event.target.value })} /></label><div className="grid grid-cols-2 gap-3">{[['min_selection', 'Minimum choices'], ['max_selection', 'Maximum choices']].map(([key, label]) => <label key={key} className="text-sm">{label}<input type="number" min={key === 'max_selection' ? 1 : 0} max={20} required className="field mt-1" value={groupForm[key]} onChange={event => setGroupForm({ ...groupForm, [key]: event.target.value })} /></label>)}</div><label className="text-sm flex gap-2"><input type="checkbox" checked={groupForm.is_required} onChange={event => setGroupForm({ ...groupForm, is_required: event.target.checked, min_selection: event.target.checked ? 1 : 0 })} />Required</label><button disabled={busy} className="btn-secondary">Add group</button></form>
  </div></Modal>
}
