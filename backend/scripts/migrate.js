// One command for fresh AND existing databases. Never resets existing tables.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true })
const { Pool } = require('pg')

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in backend/.env first.')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Two developers starting setup together must not interleave schema changes.
    await client.query('SELECT pg_advisory_xact_lock($1)', [2162026])
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    const names = tables.rows.map(row => row.tablename)
    if (!names.includes('users')) {
      if (names.length) throw new Error('Database contains unrelated or partial tables. Choose an empty database; nothing was changed.')
      await client.query(await fs.readFile(path.join(__dirname, '../db/schema.sql'), 'utf8'))
      console.log('Created base schema in the empty database.')
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    const directory = path.join(__dirname, '../db/migrations')
    const files = (await fs.readdir(directory)).filter(file => /^\d+_.*\.sql$/.test(file)).sort()
    for (const file of files) {
      const sql = await fs.readFile(path.join(directory, file), 'utf8')
      const checksum = crypto.createHash('sha256').update(sql).digest('hex')
      const previous = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [file])
      if (previous.rows.length) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} was edited. Restore it and add a new migration instead.`)
        continue
      }
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file, checksum])
      console.log(`Applied ${file}`)
    }
    // These are CREATE OR REPLACE definitions, refreshed after their columns exist.
    const functionsDir = path.join(__dirname, '../db/functions')
    for (const file of (await fs.readdir(functionsDir)).filter(file => file.endsWith('.sql')).sort()) {
      await client.query(await fs.readFile(path.join(functionsDir, file), 'utf8'))
      console.log(`Installed ${file}`)
    }
    await client.query('COMMIT')
    console.log('Database ready. Existing users, restaurants and orders were preserved.')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch(error => {
  console.error(`Migration failed: ${error.message}`)
  process.exitCode = 1
})
