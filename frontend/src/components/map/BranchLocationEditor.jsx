import { useState } from 'react'
import LocationPicker from './LocationPicker'
import { setBranchLocation } from '../../services/ownerApi'
import { errorMessage } from '../../utils/format'

// "Set restaurant location" for one branch on the owner dashboard. The pin
// is the pickup point used by "near me" search and by live order tracking.
export default function BranchLocationEditor({ branch, onSaved }) {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState(
    branch.latitude !== null && branch.latitude !== undefined
      ? { latitude: branch.latitude, longitude: branch.longitude }
      : null
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!pin) { setError('Drop a pin on the map first.'); return }
    setSaving(true)
    setError('')
    try {
      await setBranchLocation(branch.id, pin.latitude, pin.longitude)
      setOpen(false)
      onSaved()
    } catch (err) {
      setError(errorMessage(err, 'Could not save the branch location.'))
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="text-xs text-orange-700 underline" onClick={() => setOpen(true)}>
        📍 {branch.latitude !== null && branch.latitude !== undefined ? 'Edit location' : 'Set location'}
      </button>
    )
  }

  return (
    <div className="mt-3 w-full">
      <LocationPicker value={pin} onChange={setPin} className="h-64 w-full" />
      {error && <p className="notice-error mt-2" role="alert">{error}</p>}
      <div className="flex gap-2 mt-2">
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save location'}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  )
}
