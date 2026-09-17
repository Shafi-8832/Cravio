import { Link } from 'react-router-dom'
import FoodImage from './FoodImage'
import Icon from './Icon'
import { ACCENTS, ROLE_LIST, slugForRole } from '../utils/roles'

// Real delivery apps ask "who are you here as?" before they ask for a
// password, because a rider and a diner want completely different things
// from the next screen. This is that fork; each card leads to its own
// login or signup page.
export default function RoleChooser({ signup = false }) {
  return <main className="page-shell py-12">
    <div className="text-center max-w-2xl mx-auto mb-10">
      <p className="eyebrow mb-3">{signup ? 'Join Cravio' : 'Welcome back'}</p>
      <h1 className="text-4xl md:text-5xl font-extrabold leading-tight">
        {signup ? <>How would you like<br />to use Cravio?</> : <>Good to see you.<br />Which account?</>}
      </h1>
      <p className="text-stone-600 text-sm md:text-base mt-5">
        {signup
          ? 'Pick the account that fits you. You can always create another one later with a different email.'
          : 'Choose how you use Cravio and we will take you to the right place.'}
      </p>
    </div>

    <div className="grid md:grid-cols-3 gap-6">
      {ROLE_LIST.map(role => {
        const accent = ACCENTS[role.accent]
        return <Link
          key={role.key}
          to={`${signup ? '/signup' : '/login'}/${slugForRole(role.key)}`}
          className={'surface overflow-hidden group border transition-colors ' + accent.ring}>
          <div className="h-44 overflow-hidden bg-stone-100">
            <FoodImage src={role.photo} alt={role.photoAlt} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
          </div>
          <div className={'p-6 ' + accent.panel}>
            <span className="text-4xl block mb-3" aria-hidden="true">{role.emoji}</span>
            <h2 className="text-xl font-extrabold">{role.label}</h2>
            <p className={'text-sm font-semibold mt-1 ' + accent.text}>{role.tagline}</p>
            <p className="text-sm text-stone-600 mt-3 leading-relaxed">{role.blurb}</p>
            <span className="inline-flex items-center gap-1 text-sm font-bold mt-5">
              {signup ? 'Create account' : 'Log in'} <Icon name="arrow" size={16} />
            </span>
          </div>
        </Link>
      })}
    </div>

    <p className="text-center text-sm muted mt-10">
      {signup ? 'Already with us? ' : 'No account yet? '}
      <Link className="font-bold text-orange-700" to={signup ? '/login' : '/signup'}>
        {signup ? 'Log in instead' : 'Create one'}
      </Link>
    </p>
    <p className="text-center text-xs muted mt-3">
      Administrator accounts are created by the platform team, not through signup.
      {/* Admins get no card, so the chooser still has to offer them a door. */}
      {!signup && <> <Link className="font-bold text-stone-700 underline" to="/admin/login">Staff log in</Link></>}
    </p>
  </main>
}
