import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { updateProfile } from '../../services/accountApi'
import { changePassword } from '../../services/profileApi'
import { errorMessage } from '../../utils/format'

// The block every role sees, written once. Name, phone and password are
// editable; email and role are not, because changing either would change who
// the account is — that is an admin action, not a profile edit.
export default function ProfileIdentity({ user }) {
  const { refreshUser } = useAuth()
  const [details, setDetails] = useState({ name: user.name, phone: user.phone || '' })
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function saveDetails(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      refreshUser((await updateProfile(details)).data.user)
      setNotice('Your details have been updated.')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function savePassword(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const response = await changePassword(passwords)
      setPasswords({ current_password: '', new_password: '' })
      setNotice(response.data.message)
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  return <section className="surface p-6">
    <h2 className="text-xl font-bold">Your details</h2>
    <p className="text-sm muted mt-1">
      {user.email} · <span className="capitalize">{user.role.replaceAll('_', ' ')}</span>
      {user.created_at && <> · with us since {new Date(user.created_at).toLocaleDateString()}</>}
    </p>
    {error && <p className="notice-error mt-4" role="alert">{error}</p>}
    {notice && <p className="notice-success mt-4" role="status">{notice}</p>}

    <form onSubmit={saveDetails} className="grid sm:grid-cols-2 gap-4 mt-5">
      <label className="text-sm">Name
        <input className="field mt-1" required maxLength={100} value={details.name}
          onChange={event => setDetails({ ...details, name: event.target.value })} />
      </label>
      <label className="text-sm">Phone
        <input className="field mt-1" type="tel" required maxLength={20} value={details.phone}
          onChange={event => setDetails({ ...details, phone: event.target.value })} />
      </label>
      <label className="text-sm">Email
        {/* Read-only: the account is identified by this address. */}
        <input className="field mt-1" value={user.email} disabled />
      </label>
      <div className="flex items-end"><button disabled={busy} className="btn-primary">Save details</button></div>
    </form>

    <form onSubmit={savePassword} className="grid sm:grid-cols-2 gap-4 mt-7 pt-6 border-t border-stone-200">
      <h3 className="font-bold sm:col-span-2">Change password</h3>
      <label className="text-sm">Current password
        <input className="field mt-1" type="password" required autoComplete="current-password" maxLength={72}
          value={passwords.current_password}
          onChange={event => setPasswords({ ...passwords, current_password: event.target.value })} />
      </label>
      <label className="text-sm">New password
        <input className="field mt-1" type="password" required autoComplete="new-password" minLength={8} maxLength={72}
          value={passwords.new_password}
          onChange={event => setPasswords({ ...passwords, new_password: event.target.value })} />
      </label>
      <div><button disabled={busy} className="btn-secondary">Update password</button></div>
    </form>
  </section>
}

// Small shared pieces the four role views all lay their numbers out with.
export function StatGrid({ children }) {
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{children}</div>
}

export function Stat({ label, value, hint }) {
  return <div className="surface p-4">
    <p className="text-xs muted uppercase tracking-wide">{label}</p>
    <p className="text-2xl font-extrabold mt-1">{value}</p>
    {hint && <p className="text-xs muted mt-1">{hint}</p>}
  </div>
}
