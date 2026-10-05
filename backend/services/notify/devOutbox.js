// DEVELOPMENT-ONLY "provider": instead of sending, it appends the message
// to backend/.dev-outbox/outbox.jsonl (gitignored). This lets the team and
// the test suite run the full OTP flow without paid email/SMS accounts.
//
// It writes the code to a local file, so it must never run in production —
// notify/index.js refuses to start the server if it is selected there.
const fs = require('node:fs/promises')
const path = require('node:path')

const OUTBOX_DIR = path.join(__dirname, '../../.dev-outbox')
const OUTBOX_FILE = path.join(OUTBOX_DIR, 'outbox.jsonl')

function missingConfig() {
  return []
}

// One JSON object per line, so a reader can take the newest line for a
// given recipient without parsing the whole file as one document.
async function append(entry) {
  await fs.mkdir(OUTBOX_DIR, { recursive: true })
  await fs.appendFile(OUTBOX_FILE, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n', { mode: 0o600 })
  // Also echo it to the backend terminal, so a developer signing up in the
  // browser can read the code right there instead of opening the file.
  // Safe for the same reason the file is: outbox never runs in production.
  console.log(`[dev outbox] ${entry.channel} to ${entry.to}: ${entry.text}`)
}

const email = { name: 'outbox', missingConfig, send: message => append({ channel: 'email', ...message }) }
const sms = { name: 'outbox', missingConfig, send: message => append({ channel: 'phone', ...message }) }

module.exports = { email, sms, OUTBOX_FILE }
