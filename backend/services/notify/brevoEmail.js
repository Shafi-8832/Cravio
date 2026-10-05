// Email through Brevo's HTTPS API (brevo.com, free tier 300 emails/day).
// Same job as smtpEmail.js, but over HTTPS port 443 instead of an SMTP
// port — some hosts (e.g. free Render instances) block outbound SMTP.
// Uses Node's built-in fetch, so no extra npm package is needed.
const REQUIRED = ['BREVO_API_KEY', 'EMAIL_FROM']

const API_URL = 'https://api.brevo.com/v3/smtp/email'

function missingConfig() {
  return REQUIRED.filter(name => !process.env[name])
}

// EMAIL_FROM is written like a normal From header: "Cravio <no-reply@x.com>"
// (or just the address). Brevo wants the name and address separately.
function parseFrom(from) {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from)
  return match ? { name: match[1] || 'Cravio', email: match[2].trim() } : { name: 'Cravio', email: from.trim() }
}

async function send({ to, subject, text }) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      sender: parseFrom(process.env.EMAIL_FROM),
      to: [{ email: to }],
      subject,
      textContent: text
    }),
    signal: AbortSignal.timeout(10000)
  })

  // 201 = accepted for delivery. Only the status is reported, never the
  // message body (it contains the code).
  if (!response.ok) {
    throw new Error(`Brevo rejected the email (HTTP ${response.status})`)
  }
}

module.exports = { name: 'brevo', missingConfig, send }
