// Test-only helpers for reading the OTP codes that the development outbox
// provider (services/notify/devOutbox.js) writes instead of sending.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
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

// Starts an extra API server on `port` with some settings changed (e.g. a
// verification switch turned off) and waits until it answers. Keys listed in
// `remove` are deleted from the environment first. Caller kills it.
async function startApiServer(port, overrides, remove = []) {
  const env = { ...process.env, ...overrides, PORT: String(port) }
  for (const key of remove) delete env[key]
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' })
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return server
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  server.kill('SIGTERM')
  throw new Error(`API on port ${port} failed to start`)
}

module.exports = { latestCode, uniquePhone, startApiServer }
