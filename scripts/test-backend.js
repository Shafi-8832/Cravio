// This harness never uses the application database as its test target.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const root = path.join(__dirname, '..')
require(path.join(root, 'backend/node_modules/dotenv')).config({ path: path.join(root, 'backend/.env'), quiet: true })

function run(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: path.join(root, 'backend'), env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} failed (${code})`)))
  })
}

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL
  if (!testUrl) throw new Error('Set TEST_DATABASE_URL to a separate database whose name ends in _test or _review.')
  const test = new URL(testUrl)
  if (!/^postgres(ql)?:$/.test(test.protocol) || !/_(test|review)$/.test(test.pathname)) throw new Error('Test database name must end in _test or _review.')
  if (process.env.DATABASE_URL) {
    const app = new URL(process.env.DATABASE_URL)
    if (test.hostname === app.hostname && (test.port || '5432') === (app.port || '5432') && test.pathname === app.pathname) {
      throw new Error('TEST_DATABASE_URL must point to a different database from DATABASE_URL.')
    }
  }
  const port = process.env.TEST_PORT || '8011'
  const env = { ...process.env, DATABASE_URL: testUrl, JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    PORT: port, NODE_ENV: 'test', ALLOW_DEMO_SEED: 'true', DEMO_PASSWORD: 'password123',
    ALLOW_MANUAL_PAYMENTS: 'true', TEST_BASE_URL: `http://127.0.0.1:${port}` }
  await run(path.join(root, 'backend/scripts/migrate.js'), env)
  await run(path.join(root, 'backend/scripts/seed.js'), { ...env, SEED_ACCOUNTS_ONLY: 'false' })
  await run(path.join(root, 'backend/scripts/seedBangladesh.js'), env)
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(root, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', chunk => { log = (log + chunk).slice(-12000) })
  server.stderr.on('data', chunk => { log = (log + chunk).slice(-12000) })
  server.on('error', error => { log += error.message })
  try {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) {
      if (server.exitCode !== null) break
      try {
        const response = await fetch(`${env.TEST_BASE_URL}/`)
        if (response.ok) { ready = true; break }
      } catch { /* Retry while the child starts listening. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!ready) throw new Error(`Test API failed to start. ${log}`)
    for (const name of ['e2e.js', 'marketplace.js', 'operations.js']) {
      const file = path.join(root, 'backend/tests', name)
      if (fs.existsSync(file)) await run(file, env)
    }
  } catch (error) {
    console.error(log)
    throw error
  } finally {
    server.kill('SIGTERM')
  }
}
main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
