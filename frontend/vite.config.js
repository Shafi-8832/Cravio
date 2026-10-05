import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // A production bundle without VITE_API_URL would quietly call
  // http://localhost:8000 from every visitor's browser. On Vercel (which sets
  // VERCEL=1 during builds) that is always a mistake, so fail the build with
  // a clear message instead of deploying a site that cannot reach its API.
  if (command === 'build' && process.env.VERCEL) {
    const apiUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL || ''
    if (!/^https:\/\//.test(apiUrl)) {
      throw new Error('VITE_API_URL must be set to the https:// URL of the Render backend in the Vercel project settings.')
    }
  }

  return {
    plugins: [react()],
  }
})
