import { useEffect, useState } from 'react'
import logo from '../../assets/brand/cravio-logo.png'
import ClocheArt from './ClocheArt'
import './intro.css'

// ============================================================
// Every timing of the intro, in milliseconds, in one place.
// Each step is { start, duration } measured from the moment the intro
// appears. They are handed to intro.css as CSS variables (see
// timingVariables below), so changing a number here is all it takes.
// ============================================================
const INTRO_TIMING = {
  glowRise:     { start: 0,    duration: 600 },   // 1. glow rises, specks float
  clocheArrive: { start: 600,  duration: 1000 },  // 2. cloche slides in and bounces
  lidLift:      { start: 1600, duration: 800 },   // 3. lid tilts up, light bursts out
  steamDraw:    { start: 1750, duration: 650 },   //    steam curls are drawn
  steamDrift:   { start: 2400, duration: 1000 },  // 4. steam drifts up and fades
  logoSwap:     { start: 2500, duration: 700 },   //    drawn cloche -> real logo
  tagline:      { start: 3000, duration: 450, wordGap: 220 },
  exit:         { start: 3600, duration: 900 },   // 5. circular reveal, then unmount
  reducedMotion: { start: 0,   duration: 1000 },  // the whole intro when motion is reduced
}
const TOTAL_MS = INTRO_TIMING.exit.start + INTRO_TIMING.exit.duration

// Once per browser-tab session: sessionStorage survives a reload but is
// emptied when the tab is closed. Delete this key to see the intro again.
const SESSION_KEY = 'cravio:intro-played'

// The intro belongs to the landing page only. A deep link (a restaurant,
// an order, the login page) opens straight on that page.
const INTRO_PATH = '/'

const TAGLINE_WORDS = ['Cravings,', 'delivered.']

// The floating amber specks: where each starts, its size and its timing.
// Fixed values (not Math.random) so the scene looks the same every time.
const SPECKS = [
  { left: 8,  size: 3, delay: 0,    duration: 4200 },
  { left: 17, size: 2, delay: 500,  duration: 3600 },
  { left: 26, size: 4, delay: 150,  duration: 4600 },
  { left: 34, size: 2, delay: 900,  duration: 3800 },
  { left: 43, size: 3, delay: 300,  duration: 4400 },
  { left: 51, size: 2, delay: 1200, duration: 3400 },
  { left: 59, size: 4, delay: 50,   duration: 4800 },
  { left: 66, size: 2, delay: 700,  duration: 3700 },
  { left: 74, size: 3, delay: 250,  duration: 4300 },
  { left: 82, size: 2, delay: 1000, duration: 3500 },
  { left: 89, size: 3, delay: 400,  duration: 4100 },
  { left: 95, size: 2, delay: 800,  duration: 3900 },
]

// sessionStorage can throw (blocked storage, some private modes). If it
// does, the intro simply plays and nothing is remembered.
function alreadyPlayed() {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}

function rememberPlayed() {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1')
  } catch {
    // Nothing to do: without storage the intro may show again on reload.
  }
}

// Decided once, when the app first loads:
//   'none'    -> not on the landing page, already seen in this tab, or the
//                tab was opened in the background (nobody would see it, and
//                browsers slow down timers in hidden tabs)
//   'reduced' -> the system asks for less motion: a 1-second logo fade only
//   'full'    -> the whole scene
function chooseMode() {
  if (typeof window === 'undefined') return 'none'
  if (window.location.pathname !== INTRO_PATH) return 'none'
  if (alreadyPlayed()) return 'none'
  if (document.visibilityState === 'hidden') return 'none'
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return reduceMotion ? 'reduced' : 'full'
}

// INTRO_TIMING -> { '--lidLift-start': '1600ms', '--lidLift-duration': '800ms', ... }
function timingVariables() {
  const variables = { '--intro-total': TOTAL_MS + 'ms' }
  for (const [name, step] of Object.entries(INTRO_TIMING)) {
    variables[`--${name}-start`] = step.start + 'ms'
    variables[`--${name}-duration`] = step.duration + 'ms'
  }
  return variables
}

// The intro overlay. It is rendered NEXT TO the app (see App.jsx), not in
// front of it in the loading order: the real page mounts and fetches its
// data underneath at the same time, so the intro never delays anything.
export default function IntroOverlay() {
  const [mode] = useState(chooseMode)
  // 'playing' -> 'exiting' (circular reveal) -> 'done' (removed)
  const [phase, setPhase] = useState('playing')
  const visible = mode !== 'none' && phase !== 'done'

  // Remember the intro for this tab, and lock page scrolling while it shows.
  useEffect(() => {
    if (!visible) return
    rememberPlayed()
    const html = document.documentElement
    const body = document.body
    const previous = { html: html.style.overflow, body: body.style.overflow }
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = previous.html
      body.style.overflow = previous.body
    }
  }, [visible])

  // The timeline's two state changes. Everything in between is CSS
  // animation delays, all counted from the same moment the overlay appeared.
  useEffect(() => {
    if (!visible) return
    let delay
    let next
    if (mode === 'reduced') {
      delay = INTRO_TIMING.reducedMotion.duration
      next = 'done'
    } else if (phase === 'playing') {
      delay = INTRO_TIMING.exit.start
      next = 'exiting'
    } else {
      delay = INTRO_TIMING.exit.duration
      next = 'done'
    }
    const timer = setTimeout(() => setPhase(next), delay)
    return () => clearTimeout(timer)
  }, [visible, mode, phase])

  // "Skip intro" and Esc jump straight to the exit (or close at once when
  // motion is reduced). Skipping during the exit changes nothing.
  // Leaving the tab mid-intro ends it, so nobody comes back to a half-played
  // scene waiting on a slowed-down background timer.
  function skip() {
    if (mode === 'reduced') setPhase('done')
    else setPhase(current => current === 'playing' ? 'exiting' : current)
  }

  useEffect(() => {
    if (!visible) return
    function handleKey(event) {
      if (event.key === 'Escape') skip()
    }
    function handleVisibility() {
      if (document.visibilityState === 'hidden') setPhase('done')
    }
    window.addEventListener('keydown', handleKey)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  })

  if (!visible) return null

  let className = 'intro-overlay'
  if (mode === 'reduced') className += ' is-reduced'
  if (phase === 'exiting') className += ' is-exiting'

  // No role="dialog" / focus trap on purpose: the page underneath stays
  // reachable for screen readers, and the only control is the skip button.
  return <div className={className} style={timingVariables()}>
    {mode === 'full' ? <FullScene /> : <ReducedScene />}
    <button type="button" className="intro-skip" onClick={skip}>Skip intro</button>
  </div>
}

// The full 4.5-second scene.
function FullScene() {
  return <>
    {/* Background with a circular hole that grows during the exit. A hole in
        a mask is drawn by a black circle; scaling that circle (transform only)
        opens the overlay onto the real page. */}
    <svg className="intro-backdrop" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="intro-bg" cx="0.5" cy="0.55" r="0.75">
          <stop offset="0" stopColor="#2B1410" />
          <stop offset="1" stopColor="#1C0F0A" />
        </radialGradient>
        <mask id="intro-hole-mask">
          <rect width="100" height="100" fill="white" />
          <circle className="intro-hole" cx="50" cy="50" r="75" fill="black" />
        </mask>
      </defs>
      <rect width="100" height="100" fill="url(#intro-bg)" mask="url(#intro-hole-mask)" />
      {/* The glowing edge of the opening circle. */}
      <circle className="intro-ring" cx="50" cy="50" r="75" fill="none" stroke="#F59E0B" strokeWidth="2.4" />
      <circle className="intro-ring" cx="50" cy="50" r="75" fill="none" stroke="#FFF4E0" strokeWidth="0.8" />
    </svg>

    <div className="intro-specks" aria-hidden="true">
      {SPECKS.map((speck, index) => <span key={index} className="intro-speck" style={{
        left: speck.left + '%',
        width: speck.size,
        height: speck.size,
        animationDelay: speck.delay + 'ms',
        animationDuration: speck.duration + 'ms',
      }} />)}
    </div>

    <div className="intro-scene" aria-hidden="true">
      <div className="intro-stage">
        <div className="intro-glow" />
        {/* Two wrappers because each one animates its own transform:
            the outer one travels in from the left, the inner one fades and
            shrinks away when the real logo takes over. */}
        <div className="intro-cloche-travel">
          <div className="intro-streaks">
            <span style={{ top: '44%', width: '58%' }} />
            <span style={{ top: '55%', width: '82%' }} />
            <span style={{ top: '65%', width: '46%' }} />
            <span style={{ top: '74%', width: '30%' }} />
          </div>
          <div className="intro-cloche-swap">
            <ClocheArt />
          </div>
        </div>
        {/* Our real logo file (not the CravioLogo component: that one sizes
            by a fixed pixel height, and here the logo scales with the stage). */}
        <img className="intro-logo" src={logo} alt="" draggable="false" />
      </div>
      <p className="intro-tagline">
        {TAGLINE_WORDS.map((word, index) => <span key={word} className="intro-word" style={{
          animationDelay: (INTRO_TIMING.tagline.start + index * INTRO_TIMING.tagline.wordGap) + 'ms',
          animationDuration: INTRO_TIMING.tagline.duration + 'ms',
        }}>{word}</span>)}
      </p>
    </div>

    <div className="intro-progress" aria-hidden="true" />
  </>
}

// Reduced motion: no scene, only the logo fading in and out within 1 second.
function ReducedScene() {
  return <div className="intro-reduced-stage" aria-hidden="true">
    <div className="intro-reduced-glow" />
    <img className="intro-reduced-logo" src={logo} alt="" draggable="false" />
  </div>
}
