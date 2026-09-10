// Local demonstration only. Uses the same safe import path as real catalog data.
require('dotenv').config()
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Set ALLOW_DEMO_SEED=true for local development only.')
  if (!process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD.length < 8) throw new Error('Set DEMO_PASSWORD to a local test password (8+ characters).')
  const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, SEED_ACCOUNTS_ONLY: 'true' }, stdio: 'inherit' })
  if (seed.status !== 0) throw new Error('Base demonstration seed failed.')
  const pool = require('../db/pool')
  const { importCatalog } = require('./importCatalog')
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/bangladesh-demo.json'), 'utf8'))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await importCatalog(client, catalog)
    await client.query('COMMIT')
    console.log('Eight-division demo catalog imported:', result)
    console.log('Fictional restaurants; photos are illustrative; orders are tests only.')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release(); await pool.end() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
