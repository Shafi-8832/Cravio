// The three accounts a visitor can create for themselves. Admin is absent
// on purpose: it is created by `npm run seed:admin`, never by signup, so
// offering it here would promise something the API refuses.
//
// Everything a role-specific login or signup screen needs to look like its
// own product lives in one place, so the pages stay layout-only.
export const AUTH_ROLES = {
  customer: {
    key: 'customer',
    label: 'Customer',
    emoji: '🍽️',
    tagline: 'Order delicious food',
    blurb: 'Browse restaurants near you, build your bag and track the order to your door.',
    loginTitle: 'Hungry again?',
    loginSubtitle: 'Log in to pick up where your cravings left off.',
    signupTitle: 'Let’s get you fed.',
    signupSubtitle: 'Create a customer account and order in a couple of taps.',
    photo: '/media/dish-kacchi-biryani.jpg',
    photoAlt: 'A plate of kacchi biryani',
    accent: 'orange',
    perks: ['Order from every division', 'Save your favourite places', 'Track each order live'],
  },
  rider: {
    key: 'rider',
    label: 'Rider',
    emoji: '🚴',
    tagline: 'Deliver and earn',
    blurb: 'Go online, claim the deliveries that suit you and get paid for every completed trip.',
    loginTitle: 'Ready to ride?',
    loginSubtitle: 'Log in, go online and start claiming deliveries.',
    signupTitle: 'Join the delivery team.',
    signupSubtitle: 'Set up your rider profile and pick your vehicle.',
    photo: '/media/dish-burger.jpg',
    photoAlt: 'A burger ready for delivery',
    accent: 'green',
    perks: ['Choose your own hours', 'See the fee before you accept', 'Cash on delivery settled for you'],
  },
  restaurant_owner: {
    key: 'restaurant_owner',
    label: 'Restaurant owner',
    emoji: '👨‍🍳',
    tagline: 'Grow your restaurant',
    blurb: 'Publish your menu, manage branches and watch orders arrive from across the country.',
    loginTitle: 'Welcome back, chef.',
    loginSubtitle: 'Log in to your kitchen dashboard.',
    signupTitle: 'Put your kitchen on Cravio.',
    signupSubtitle: 'Create an owner account and start building your menu.',
    photo: '/media/dish-fried-chicken.jpg',
    photoAlt: 'A restaurant kitchen dish',
    accent: 'plum',
    perks: ['Your menu, your prices', 'Accept or reject every order', 'Daily sales at a glance'],
  },
}

// Administrators deliberately have no card on the chooser: their accounts
// are seeded by the platform team, never signed up for. They still need a
// way in, so /login/staff renders this screen.
//
// `key` is the real database role, not the URL word 'staff', because it is
// sent as expectedRole and the server matches it against users.role. This
// screen is scoped exactly like the three cards: a customer who types their
// own password here is refused by the server with a 403. `noSignup` only
// hides the "create an account" footer — admins are seeded, not registered.
export const STAFF_LOGIN = {
  key: 'admin',
  noSignup: true,
  label: 'Staff',
  emoji: '🛡️',
  tagline: 'Platform team',
  blurb: 'Administrator accounts are created by the platform team and are not tied to a signup card.',
  loginTitle: 'Staff sign in.',
  loginSubtitle: 'Log in with your platform credentials.',
  photo: '/media/dish-margherita.jpg',
  photoAlt: 'A margherita pizza',
  accent: 'plum',
  perks: ['Moderate restaurants and users', 'Watch orders across the platform', 'Suspend accounts when needed'],
}

// Short URL segments, because /signup/restaurant_owner reads badly and
// leaks the database's spelling of the role into the address bar.
const SLUGS = { customer: 'customer', rider: 'rider', owner: 'restaurant_owner' }

export const roleFromSlug = slug => AUTH_ROLES[SLUGS[slug]] || null

// Login knows one screen signup does not: the cardless staff login. Keeping
// it out of roleFromSlug is what stops /signup/staff from ever existing.
export const loginRoleFromSlug = slug => (slug === 'staff' ? STAFF_LOGIN : roleFromSlug(slug))
export const slugForRole = role => Object.keys(SLUGS).find(slug => SLUGS[slug] === role)
export const ROLE_LIST = [AUTH_ROLES.customer, AUTH_ROLES.rider, AUTH_ROLES.restaurant_owner]

// Tailwind cannot see class names built at runtime, so each accent's
// classes are written out in full here rather than assembled from strings.
export const ACCENTS = {
  orange: {
    panel: 'bg-[#fbe7d5]',
    text: 'text-orange-700',
    ring: 'hover:border-orange-400 focus-visible:outline-orange-500',
    chip: 'bg-orange-100 text-orange-800',
    button: 'bg-orange-600 hover:bg-orange-700',
  },
  green: {
    panel: 'bg-[#e8edde]',
    text: 'text-green-800',
    ring: 'hover:border-green-500 focus-visible:outline-green-700',
    chip: 'bg-green-100 text-green-900',
    button: 'bg-green-800 hover:bg-green-900',
  },
  plum: {
    panel: 'bg-[#efe3ea]',
    text: 'text-rose-800',
    ring: 'hover:border-rose-400 focus-visible:outline-rose-600',
    chip: 'bg-rose-100 text-rose-900',
    button: 'bg-rose-800 hover:bg-rose-900',
  },
}
