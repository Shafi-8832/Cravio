import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { resendOtp, verifyOtp } from '../services/authApi'
import { errorMessage } from '../utils/format'
import Icon from '../components/Icon'

// Step two of signup: prove the email address and the phone number.
// The server sent one 6-digit code to each. Either code can be entered on
// its own; the account becomes usable once both are accepted.
//
// Arrives here from AuthForm with { email, phoneMasked, delivery, resendIn,
// loginPath } in router state. On a page refresh that state is gone, so
// the email can be typed in by hand.

// Wording for each per-channel result the server returns.
const RESULT_TEXT = {
  invalid: result => `Incorrect code. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`,
  expired: () => 'This code has expired. Press “Resend codes” for a new one.',
  locked: () => 'Too many incorrect attempts. Press “Resend codes” for a new one.',
}

const CHANNEL_LABEL = { email: 'Email', phone: 'Phone' }

export default function VerifyAccountPage() {
  const { state } = useLocation()
  const [email, setEmail] = useState(state?.email || '')
  const [codes, setCodes] = useState({ email: '', phone: '' })
  const [verified, setVerified] = useState({ email: false, phone: false })
  // Which codes this deployment requires. The server sends the list with
  // signup and with an "unverified" login refusal; phone can be switched
  // off on the server (PHONE_OTP_REQUIRED=false). Default: both.
  const [channels, setChannels] = useState(state?.channels || ['email', 'phone'])
  // The server's own verdict, so the page never decides "verified" itself.
  const [accountVerified, setAccountVerified] = useState(false)
  const [channelErrors, setChannelErrors] = useState({})
  // If a send failed during signup, say so straight away.
  const [error, setError] = useState(deliveryProblem(state?.delivery))
  const [notice, setNotice] = useState(state?.unfinished
    ? 'Your account is not verified yet. Enter your codes, or press “Resend codes” if they have expired.'
    : '')
  const [busy, setBusy] = useState(false)
  // Seconds until "Resend codes" unlocks. The server enforces the real
  // cooldown; this countdown only stops the visitor clicking into a 429.
  const [cooldown, setCooldown] = useState(state?.resendIn || 0)
  const loginPath = state?.loginPath || '/login'
  const done = accountVerified
  const needsPhone = channels.includes('phone')

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = setTimeout(() => setCooldown(seconds => seconds - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    setChannelErrors({})
    // Only send codes for channels that still need verifying.
    const payload = { email }
    if (!verified.email && codes.email) payload.email_otp = codes.email
    if (needsPhone && !verified.phone && codes.phone) payload.phone_otp = codes.phone
    try {
      const response = await verifyOtp(payload)
      applyResult(response.data)
    } catch (err) {
      // A failed verify still says which channel (if any) succeeded, so a
      // right email code is kept even when the phone code was wrong.
      if (err.response?.data?.results) applyResult(err.response.data)
      else setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function applyResult(data) {
    setVerified({ email: data.email_verified, phone: data.phone_verified })
    if (data.channels) setChannels(data.channels)
    setAccountVerified(Boolean(data.account_verified))
    const errors = {}
    const successes = []
    for (const [channel, result] of Object.entries(data.results || {})) {
      if (RESULT_TEXT[result.status]) errors[channel] = RESULT_TEXT[result.status](result)
      else successes.push(`${CHANNEL_LABEL[channel]} verified.`)
    }
    setChannelErrors(errors)
    if (successes.length) setNotice(successes.join(' '))
    // A wrong code is cleared so the next attempt starts from an empty box.
    setCodes(current => ({
      email: errors.email ? '' : current.email,
      phone: errors.phone ? '' : current.phone,
    }))
  }

  async function resend() {
    setError('')
    setNotice('')
    setChannelErrors({})
    // Ask only for the codes still missing.
    const channel = !needsPhone || verified.phone ? 'email' : verified.email ? 'phone' : 'both'
    try {
      const response = await resendOtp({ email, channel })
      setCooldown(response.data.resend_available_in)
      const problem = deliveryProblem(response.data.delivery)
      if (problem) setError(problem)
      else setNotice(sentNotice(response.data.delivery, response.data.phone_masked) || response.data.message)
    } catch (err) {
      if (err.response?.data?.code === 'OTP_RESEND_COOLDOWN') setCooldown(err.response.data.retry_after)
      setError(errorMessage(err))
    }
  }

  if (done) {
    return <main className="page-shell py-16">
      <div className="max-w-md mx-auto text-center">
        <div className="w-14 h-14 rounded-full bg-green-100 text-green-700 grid place-items-center mx-auto mb-5"><Icon name="check" size={28} /></div>
        <h1 className="text-3xl font-extrabold mb-3">You're verified</h1>
        <p className="text-sm muted mb-7">Your {needsPhone ? 'email and phone number are' : 'email is'} confirmed. Log in to start using Cravio.</p>
        <Link to={loginPath} className="btn-primary w-full !py-4">Go to login <Icon name="arrow" size={18} /></Link>
      </div>
    </main>
  }

  return <main className="page-shell py-12">
    <div className="max-w-md mx-auto">
      <p className="eyebrow mb-3 text-orange-600">One last step</p>
      <h1 className="text-3xl font-extrabold mb-3">{needsPhone ? 'Verify your email and phone' : 'Verify your email'}</h1>
      <p className="text-sm muted mb-7">
        We sent a 6-digit code to {state?.email ? <strong>{state.email}</strong> : 'your email'}
        {needsPhone && (state?.phoneMasked ? <> and another to <strong>{state.phoneMasked}</strong></> : ' and your phone')}.
        Codes expire after 5 minutes.
      </p>

      {error && <p className="notice-error mb-5" role="alert">{error}</p>}
      {notice && <p className="notice-success mb-5" role="status">{notice}</p>}

      <form onSubmit={submit} className="space-y-4">
        {!state?.email && <label className="field-label">Email address
          <input className="field mt-2" required type="email" autoComplete="email" maxLength={100}
            value={email} onChange={event => setEmail(event.target.value)} />
        </label>}
        {channels.map(channel => <CodeField
          key={channel}
          label={`${CHANNEL_LABEL[channel]} code`}
          value={codes[channel]}
          verified={verified[channel]}
          error={channelErrors[channel]}
          onChange={value => setCodes({ ...codes, [channel]: value })} />)}
        <button disabled={busy || (!codes.email && !codes.phone)} className="btn-primary w-full !py-4">
          {busy ? 'Checking…' : 'Verify'} <Icon name="arrow" size={18} />
        </button>
      </form>

      <p className="text-sm muted mt-6 text-center">
        Didn't get a code?{' '}
        {cooldown > 0
          ? <span>Resend available in {cooldown}s</span>
          : <button type="button" onClick={resend} disabled={!email} className="font-bold text-orange-600">{needsPhone ? 'Resend codes' : 'Resend code'}</button>}
      </p>
    </div>
  </main>
}

// One 6-digit box. Once its channel is verified it locks and shows a tick.
function CodeField({ label, value, verified, error, onChange }) {
  return <label className="field-label">{label}
    <input
      className="field mt-2 tracking-[0.4em] text-lg font-bold"
      inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
      placeholder={verified ? 'Verified' : '••••••'} disabled={verified}
      value={verified ? '' : value}
      // Digits only, so a pasted "123 456" still becomes a valid code.
      onChange={event => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))} />
    {verified && <span className="text-xs text-green-700 font-semibold mt-1 inline-flex items-center gap-1"><Icon name="check" size={14} /> Verified</span>}
    {error && <span className="text-xs text-red-700 font-semibold mt-1 block" role="alert">{error}</span>}
  </label>
}

// delivery = { email: 'sent' | 'failed', phone: 'sent' | 'failed' } from the server.
function deliveryProblem(delivery) {
  const failed = Object.keys(delivery || {}).filter(channel => delivery[channel] === 'failed')
  return failed.length ? `We could not send the ${failed.join(' and ')} code. Press “Resend codes” to try again.` : ''
}

function sentNotice(delivery, phoneMasked) {
  if (!delivery || Object.keys(delivery).length === 0) return ''
  const sentTo = [delivery.email && 'your email', delivery.phone && (phoneMasked || 'your phone')].filter(Boolean)
  return `A new code was sent to ${sentTo.join(' and ')}.`
}
