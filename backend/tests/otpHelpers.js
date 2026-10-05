// Test-only helpers for reading the OTP codes that the development outbox
// provider (services/notify/devOutbox.js) writes instead of sending.
const fs = require('node:fs')
const { OUTBOX_FILE } = require('../services/notify/devOutbox')

// The newest 6-digit code sent to this address/number on this channel.
function latestCode(channel, to) {
  const lines = fs.existsSync(OUTBOX_FILE) ? fs.readFileSync(OUTBOX_FILE, 'utf8').trim().split('\n') : []
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = JSON.parse(lines[i])
    if (entry.channel === channel && entry.to === to) return /\b(\d{6})\b/.exec(entry.text)[1]
  }
  throw new Error(`No ${channel} code found in the outbox for ${to}`)
}

// A unique, valid Bangladeshi mobile number per test signup, so the newest
// outbox line for that number always belongs to this run.
function uniquePhone() {
  return '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
}

module.exports = { latestCode, uniquePhone }
