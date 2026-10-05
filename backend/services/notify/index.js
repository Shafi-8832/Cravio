// The one place that knows which email/SMS company Cravio uses.
// otpService.js only calls sendEmail() and sendSms(); it never imports a
// provider directly, so swapping BulkSMSBD for another gateway means adding
// one file here and changing .env — the OTP rules stay untouched.
const smtpEmail = require('./smtpEmail')
const brevoEmail = require('./brevoEmail')
const bulkSmsBd = require('./bulkSmsBd')
const devOutbox = require('./devOutbox')
const { emailOtpRequired, phoneOtpRequired } = require('../../config/verification')

const EMAIL_PROVIDERS = { smtp: smtpEmail, brevo: brevoEmail, outbox: devOutbox.email }
const SMS_PROVIDERS = { bulksmsbd: bulkSmsBd, outbox: devOutbox.sms }

// Render sets RENDER=true on every service. Counting it as production means
// a forgotten NODE_ENV cannot silently switch a live server to the outbox
// (which would write codes to disk and print them in the logs).
const isProduction = () => process.env.NODE_ENV === 'production' || process.env.RENDER === 'true'

// Unset means "outbox" while developing. In production there is no safe
// default, so an unset provider is a startup error instead.
function pick(providers, variable) {
  const name = process.env[variable] || (isProduction() ? '' : 'outbox')
  return { name, provider: providers[name] }
}

// Called once from server.js at boot, so a misconfigured provider stops the
// server immediately instead of failing silently at the first signup.
function assertNotifyConfig() {
  const problems = []
  // A switched-off channel never sends anything, so its provider is not
  // needed (config/verification.js).
  const checks = []
  if (emailOtpRequired()) checks.push([EMAIL_PROVIDERS, 'EMAIL_PROVIDER'])
  if (phoneOtpRequired()) checks.push([SMS_PROVIDERS, 'SMS_PROVIDER'])
  for (const [providers, variable] of checks) {
    const { name, provider } = pick(providers, variable)
    if (!provider) {
      problems.push(`${variable} must be one of: ${Object.keys(providers).join(', ')}`)
      continue
    }
    if (provider.name === 'outbox' && isProduction()) {
      problems.push(`${variable}=outbox writes codes to a local file and is not allowed in production`)
    }
    const missing = provider.missingConfig()
    if (missing.length) problems.push(`${variable}=${name} needs ${missing.join(', ')}`)
  }
  if (!process.env.OTP_HMAC_SECRET || process.env.OTP_HMAC_SECRET.length < 32) {
    problems.push('OTP_HMAC_SECRET must be set to at least 32 random characters')
  }
  return problems
}

async function sendEmail(message) {
  await pick(EMAIL_PROVIDERS, 'EMAIL_PROVIDER').provider.send(message)
}

async function sendSms(message) {
  await pick(SMS_PROVIDERS, 'SMS_PROVIDER').provider.send(message)
}

module.exports = { assertNotifyConfig, sendEmail, sendSms }
