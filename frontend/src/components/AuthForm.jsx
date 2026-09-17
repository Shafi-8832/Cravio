import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { signIn, signUp } from '../services/authApi'
import { errorMessage } from '../utils/format'
import { ACCENTS, slugForRole } from '../utils/roles'
import FoodImage from './FoodImage'
import Icon from './Icon'

// Each role's landing page, keyed by the role the server sends back after a
// successful login. Anything unrecognised falls back to the customer home.
const HOME_FOR_ROLE = {
  admin: '/admin',
  restaurant_owner: '/owner',
  rider: '/rider',
  customer: '/',
}

// One form, themed per role. The role is decided by the page the visitor
// chose rather than by a dropdown inside the form: a customer signing up
// should never have to notice that riders and owners exist.
export default function AuthForm({ role, signup = false }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()
  const accent = ACCENTS[role.accent]
  const slug = slugForRole(role.key)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      // The card the visitor picked travels as `expectedRole`. It is only a
      // claim: the server reads the account's real role from the users
      // table and rejects with 403 if the two disagree. It never decides
      // what the account is.
      // The staff screen is un-scoped: it sends no expectedRole at all, so an
      // admin (who has no card) logs in exactly as before.
      const credentials = { email: form.email, password: form.password }
      if (!role.generic) credentials.expectedRole = role.key
      const response = await (signup ? signUp({ ...form, role: role.key }) : signIn(credentials))
      const signedInUser = response.data.user
      login(signedInUser, response.data.token)
      // Where we land follows the role the SERVER returned, not the card
      // that was clicked — if they ever disagree, the server wins.
      navigate(HOME_FOR_ROLE[signedInUser.role] || '/')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function field(key, label, type, placeholder, autocomplete) {
    return <label className="field-label">{label}
      <input
        className="field mt-2" required type={type} name={key} autoComplete={autocomplete}
        placeholder={placeholder}
        minLength={signup && key === 'password' ? 8 : undefined}
        maxLength={key === 'phone' ? 20 : key === 'password' ? 72 : 100}
        value={form[key]}
        onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </label>
  }

  return <main className="page-shell py-8">
    <div className="auth-layout gap-8">
      <aside className={'auth-aside p-10 flex flex-col justify-between ' + accent.panel}>
        <div>
          <p className={'eyebrow mb-4 ' + accent.text}>{role.emoji} {role.tagline}</p>
          <h2 className="text-4xl leading-tight font-extrabold">{signup ? role.signupTitle : role.loginTitle}</h2>
          <p className="text-sm muted mt-4">{role.blurb}</p>
        </div>
        <FoodImage src={role.photo} alt={role.photoAlt} className="w-full h-56 object-cover rounded-2xl my-8" eager />
        <ul className="space-y-2">
          {role.perks.map(perk => <li key={perk} className="text-sm font-semibold flex items-center gap-2">
            <span className={'w-5 h-5 rounded-full grid place-items-center text-[11px] ' + accent.chip}>✓</span>{perk}
          </li>)}
        </ul>
      </aside>

      <section className="flex items-center justify-center py-7">
        <div className="w-full max-w-md">
          <Link to={signup ? '/signup' : '/login'} className="text-sm muted inline-flex items-center gap-1 mb-5">← Choose a different account type</Link>
          <p className={'eyebrow mb-3 ' + accent.text}>{role.emoji} {role.label}</p>
          <h1 className="text-3xl font-extrabold mb-3">{signup ? role.signupTitle : role.loginTitle}</h1>
          <p className="text-sm muted mb-7">{signup ? role.signupSubtitle : role.loginSubtitle}</p>
          {error && <p className="notice-error mb-5" role="alert">{error}</p>}

          <form onSubmit={submit} className="space-y-4">
            {signup && field('name', 'Your name', 'text', 'Full name', 'name')}
            {field('email', 'Email address', 'email', 'you@example.com', 'email')}
            {field('password', 'Password', 'password', signup ? 'At least 8 characters' : 'Your password', signup ? 'new-password' : 'current-password')}
            {signup && field('phone', 'Phone number', 'tel', '017XXXXXXXX', 'tel')}
            <button disabled={busy} className={'btn-primary w-full !py-4 ' + accent.button}>
              {busy ? 'Just a moment…' : signup ? `Create ${role.label.toLowerCase()} account` : 'Log in'} <Icon name="arrow" size={18} />
            </button>
          </form>

          {/* No signup counterpart for the staff screen — admin accounts are seeded, not registered. */}
          {!role.generic && <p className="text-sm muted mt-6 text-center">
            {signup ? 'Already have an account? ' : 'New to Cravio? '}
            <Link className={'font-bold ' + accent.text} to={`${signup ? '/login' : '/signup'}/${slug}`}>
              {signup ? `Log in as a ${role.label.toLowerCase()}` : `Create a ${role.label.toLowerCase()} account`}
            </Link>
          </p>}
        </div>
      </section>
    </div>
  </main>
}
