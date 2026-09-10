const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.join(__dirname, '..')
const backendEnv = path.join(root, 'backend/.env')
if (fs.existsSync(backendEnv)) {
  console.log('Kept existing backend/.env unchanged.')
} else {
  const template = fs.readFileSync(path.join(root, 'backend/.env.example'), 'utf8')
    .replace('replace-with-at-least-32-random-characters', crypto.randomBytes(48).toString('hex'))
  fs.writeFileSync(backendEnv, template, { mode: 0o600, flag: 'wx' })
  console.log('Created backend/.env with a random JWT secret.')
}
const frontendEnv = path.join(root, 'frontend/.env')
if (!fs.existsSync(frontendEnv)) {
  fs.writeFileSync(frontendEnv, 'VITE_API_URL=http://localhost:8000\n', { flag: 'wx' })
  console.log('Created frontend/.env.')
}
console.log('Next: set DATABASE_URL and ADMIN_PASSWORD in backend/.env, then follow docs/SETUP.md.')
