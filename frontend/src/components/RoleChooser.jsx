import { Link } from 'react-router-dom'
import FoodImage from './FoodImage'
import Icon from './Icon'
import { ACCENTS, ROLE_LIST, slugForRole } from '../utils/roles'

// Real delivery apps ask "who are you here as?" before they ask for a
// password, because a rider and a diner want completely different things
// from the next screen. This is that fork; each card leads to its own
// login or signup page.
export default function RoleChooser({ signup = false }) {
  // On desktop the page is exactly one screen tall (100svh minus the 80px
  // navbar and its 1px border) and the cards stretch to fill what the
  // heading leaves, so every photo and line of text is visible without
  // scrolling. min-h stops the cards collapsing on very short windows.
  // Phones stack the cards and scroll as normal.
  return <main className="page-shell py-6 md:py-8 flex flex-col md:h-[calc(100svh-81px)] md:min-h-[620px]">
    <div className="text-center max-w-3xl mx-auto mb-6 shrink-0">
      <p className="eyebrow mb-2">{signup ? 'Join Cravio' : 'Welcome back'}</p>
      <h1 className="text-3xl md:text-4xl font-extrabold leading-tight">
        {signup ? 'How would you like to use Cravio?' : 'Good to see you. Which account?'}
      </h1>
      <p className="text-stone-600 text-sm md:text-base mt-2">
        {signup
          ? 'Pick the account that fits you. You can always create another one later with a different email.'
          : 'Choose how you use Cravio and we will take you to the right place.'}
      </p>
    </div>

    <div className="grid md:grid-cols-3 gap-6 md:flex-1 md:min-h-0">
      {ROLE_LIST.map(role => {
        const accent = ACCENTS[role.accent]
        return <Link
          key={role.key}
          to={`${signup ? '/signup' : '/login'}/${slugForRole(role.key)}`}
          className={'surface overflow-hidden group border transition-colors flex flex-col ' + accent.ring}>
          {/* The photo takes whatever height the text panel leaves; on phones it
              gets a fixed height instead. It is cropped to fill the frame, so
              there are never empty bands above, below or beside it. */}
          <div className="h-56 md:h-auto md:flex-1 md:min-h-0 overflow-hidden bg-stone-100">
            <FoodImage
              src={role.photo}
              alt={role.photoAlt}
              className="h-full w-full object-cover transition-transform group-hover:scale-105" />
          </div>
          <div className={'p-5 shrink-0 ' + accent.panel}>
            <h2 className="text-xl font-extrabold flex items-center gap-3">
              <span className="text-3xl" aria-hidden="true">{role.emoji}</span>{role.label}
            </h2>
            <p className={'text-sm font-semibold mt-1 ' + accent.text}>{role.tagline}</p>
            <p className="text-sm text-stone-600 mt-2 leading-relaxed">{role.blurb}</p>
            <span className="inline-flex items-center gap-1 text-sm font-bold mt-3">
              {signup ? 'Create account' : 'Log in'} <Icon name="arrow" size={16} />
            </span>
          </div>
        </Link>
      })}
    </div>

    <p className="text-center text-sm muted mt-5 shrink-0">
      {signup ? 'Already with us? ' : 'No account yet? '}
      <Link className="font-bold text-orange-700" to={signup ? '/login' : '/signup'}>
        {signup ? 'Log in instead' : 'Create one'}
      </Link>
    </p>
    <p className="text-center text-xs muted mt-1 shrink-0">
      Administrator accounts are created by the platform team, not through signup.
      {/* Admins get no card, so the chooser still has to offer them a door. */}
      {!signup && <> <Link className="font-bold text-stone-700 underline" to="/admin/login">Staff log in</Link></>}
    </p>
  </main>
}
