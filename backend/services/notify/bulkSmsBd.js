// SMS through BulkSMSBD (bulksmsbd.net), a Bangladeshi gateway with a plain
// HTTP API. Uses Node's built-in fetch, so no extra npm package is needed.
const REQUIRED = ['BULKSMSBD_API_KEY', 'BULKSMSBD_SENDER_ID']

const API_URL = process.env.BULKSMSBD_API_URL || 'https://bulksmsbd.net/api/smsapi'

function missingConfig() {
  return REQUIRED.filter(name => !process.env[name])
}

// Cravio stores phones as 01XXXXXXXXX; the gateway wants 8801XXXXXXXXX.
function toInternational(phone) {
  return '88' + phone
}

async function send({ to, text }) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      api_key: process.env.BULKSMSBD_API_KEY,
      senderid: process.env.BULKSMSBD_SENDER_ID,
      number: toInternational(to),
      type: 'text',
      message: text
    }),
    signal: AbortSignal.timeout(10000)
  })

  // The gateway answers HTTP 200 even for failures; response_code 202 is
  // its "accepted" value. Anything else is reported as a failed send.
  const body = await response.json().catch(() => ({}))
  if (!response.ok || Number(body.response_code) !== 202) {
    throw new Error(`BulkSMSBD rejected the message (code ${body.response_code || response.status})`)
  }
}

module.exports = { name: 'bulksmsbd', missingConfig, send }
