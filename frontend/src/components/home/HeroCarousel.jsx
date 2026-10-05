import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import FoodImage from '../FoodImage'
import Icon from '../Icon'
import useNow from './useNow'
import { money } from '../../utils/format'
import { countdownLabel } from '../../utils/time'

// How long each slide stays before the carousel moves on.
const SLIDE_DELAY_MS = 3000

// Read once: people who asked their system for less motion get no auto-advance.
const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Deal, promo, deal, promo ... so the carousel alternates between the two.
function interleave(deals, promos) {
  const slides = []
  for (let i = 0; i < Math.max(deals.length, promos.length); i++) {
    if (deals[i]) slides.push({ type: 'deal', key: 'deal-' + deals[i].offer_id, deal: deals[i] })
    if (promos[i]) slides.push({ type: 'promo', key: 'promo-' + promos[i].id, promo: promos[i] })
  }
  return slides
}

// The hero carousel. Every slide comes from GET /api/home/banners: the twelve
// biggest photographed item deals running now and every usable promo code.
//   * auto-advances every 3 s, pauses while hovered / focused / touched
//   * dots + previous/next buttons
//   * swipeable on phones: the track is a CSS scroll-snap row, so the
//     browser's own scrolling does the swiping
export default function HeroCarousel({ banners, loading }) {
  const trackRef = useRef(null)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')

  const deals = banners?.rows?.deals || []
  const promos = banners?.rows?.promos || []
  // A deal slide whose offer ends while the page is open is dropped.
  const now = useNow(deals.map(deal => new Date(deal.ends_at).getTime()))
  const slides = interleave(deals.filter(deal => new Date(deal.ends_at).getTime() > now), promos)
  const count = slides.length
  const current = Math.min(index, Math.max(count - 1, 0))

  // Scroll the track so slide `target` fills it. The index itself is then
  // updated by onScroll, the same way a finger swipe updates it.
  function goTo(target) {
    const track = trackRef.current
    if (!track || count === 0) return
    const wrapped = (target + count) % count
    track.scrollTo({ left: wrapped * track.clientWidth, behavior: 'smooth' })
  }

  function handleScroll() {
    const track = trackRef.current
    if (track) setIndex(Math.round(track.scrollLeft / track.clientWidth))
  }

  // Auto-advance: one timer per shown slide. Moving (by the timer, a click
  // or a swipe) changes `current`, which clears the old timer and starts a
  // fresh 3 seconds.
  useEffect(() => {
    if (paused || count < 2 || REDUCED_MOTION) return
    const timer = setTimeout(() => {
      const track = trackRef.current
      if (track) track.scrollTo({ left: ((current + 1) % count) * track.clientWidth, behavior: 'smooth' })
    }, SLIDE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [paused, current, count])

  function copyCode(code) {
    setCopyError('')
    if (!navigator.clipboard) { setCopyError('Copying is not available in this browser. Type the code at checkout.'); return }
    navigator.clipboard.writeText(code)
      .then(() => setCopied(code))
      .catch(() => setCopyError('Could not copy the code. Type it at checkout instead.'))
  }

  if (loading) return <div className="skeleton min-h-[380px] rounded-[26px]" aria-label="Loading offers" />
  if (banners.error) return <p role="alert" className="notice-error">{banners.error}</p>
  if (count === 0) return null

  return <section aria-roledescription="carousel" aria-label="Today’s offers"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    onTouchStart={() => setPaused(true)} onTouchEnd={() => setPaused(false)}>
    <div ref={trackRef} onScroll={handleScroll} className="carousel-track flex overflow-x-auto snap-x snap-mandatory rounded-[26px]">
      {slides.map((slide, position) => <div key={slide.key} className="w-full shrink-0 snap-center" role="group" aria-roledescription="slide" aria-label={`${position + 1} of ${count}`}>
        {slide.type === 'deal'
          ? <DealSlide deal={slide.deal} now={now} eager={position === 0} />
          : <PromoSlide promo={slide.promo} copied={copied === slide.promo.code} onCopy={copyCode} />}
      </div>)}
    </div>

    <div className="flex items-center justify-between gap-4 mt-4">
      <div className="flex items-center gap-2" role="tablist" aria-label="Choose a slide">
        {slides.map((slide, position) => <button key={slide.key} type="button" role="tab" aria-selected={position === current} aria-label={'Show slide ' + (position + 1)} onClick={() => goTo(position)}
          className={'h-2 rounded-full transition-all ' + (position === current ? 'w-7 bg-orange-600' : 'w-2 bg-stone-300 hover:bg-stone-400')} />)}
      </div>
      {copyError && <p role="alert" className="text-xs text-red-700">{copyError}</p>}
      {count > 1 && <div className="flex gap-2">
        <button type="button" onClick={() => goTo(current - 1)} className="rail-arrow" aria-label="Previous slide"><Icon name="chevron" size={18} className="rotate-180" /></button>
        <button type="button" onClick={() => goTo(current + 1)} className="rail-arrow" aria-label="Next slide"><Icon name="chevron" size={18} /></button>
      </div>}
    </div>
  </section>
}

// A single deal: the dish, its restaurant, the price drop and the countdown.
function DealSlide({ deal, now, eager }) {
  const label = countdownLabel(deal.ends_at, now)
  return <article className="hero-panel grid md:grid-cols-[1.1fr_1fr] min-h-[380px]">
    <div className="px-7 pt-9 pb-4 md:px-12 md:py-12 flex flex-col justify-center relative z-10">
      <p className="eyebrow flex items-center gap-2 mb-4"><span className="w-5 h-px bg-orange-600" />Deal of the moment</p>
      <h2 className="carousel-title">{deal.item_name}</h2>
      <p className="text-stone-600 mt-3">from <strong className="text-green-950">{deal.restaurant_name}</strong></p>
      <p className="flex items-baseline gap-3 mt-5">
        <span className="text-4xl font-extrabold text-orange-600">{money(deal.discounted_price)}</span>
        <s className="text-lg text-stone-400">{money(deal.original_price)}</s>
      </p>
      <div className="flex items-center gap-3 mt-6 flex-wrap">
        <Link to={'/restaurants/' + deal.restaurant_id} className="btn-primary !px-6">Order now <Icon name="arrow" size={18} /></Link>
        {label && <span className="pill bg-white text-green-950 shadow-sm"><Icon name="clock" size={14} />ends in {label}</span>}
      </div>
    </div>
    <div className="relative flex items-center justify-center pb-8 md:pb-0 min-h-[230px]">
      <div className="hidden md:block absolute w-[430px] h-[430px] rounded-full border border-green-900/10" />
      <div className="hidden md:block absolute w-[510px] h-[510px] rounded-full border border-green-900/5" />
      <FoodImage src={deal.image_url} alt={deal.item_name} className="carousel-photo relative -rotate-3" eager={eager} />
      <div className="absolute top-4 right-6 md:top-10 md:right-12 w-20 h-20 md:w-24 md:h-24 rounded-full bg-orange-600 text-white flex flex-col items-center justify-center rotate-12 shadow-xl">
        <span className="text-2xl md:text-3xl font-extrabold leading-none">{deal.discount_percent}%</span>
        <span className="text-[10px] md:text-xs font-bold tracking-widest">OFF</span>
      </div>
    </div>
  </article>
}

// A promo code, styled as a tear-off ticket with a copy button.
function PromoSlide({ promo, copied, onCopy }) {
  return <article className="rounded-[26px] bg-green-950 text-white grid md:grid-cols-[1.1fr_1fr] min-h-[380px] relative overflow-hidden">
    <div aria-hidden="true" className="absolute -right-24 -top-24 w-96 h-96 rounded-full bg-orange-500/10" />
    <div aria-hidden="true" className="absolute -left-16 -bottom-28 w-80 h-80 rounded-full bg-white/5" />
    <div className="px-7 pt-9 pb-4 md:px-12 md:py-12 flex flex-col justify-center relative z-10">
      <p className="uppercase text-xs font-bold tracking-[.2em] text-orange-300 flex items-center gap-2 mb-4"><span className="w-5 h-px bg-orange-300" />Promo code</p>
      <h2 className="carousel-title text-white">{promo.discount_percent}% off <span className="text-orange-400">your order</span></h2>
      <p className="text-green-100/75 mt-4 max-w-md text-sm leading-relaxed">
        {promo.min_order_amount > 0 ? `On orders from ${money(promo.min_order_amount)}. ` : 'No minimum order. '}
        Valid until {promo.valid_until}. Applied at checkout, on top of any item deals.
      </p>
    </div>
    <div className="flex items-center justify-center px-7 pb-9 md:pb-0 relative z-10">
      <div className="promo-ticket w-full max-w-sm text-center">
        <p className="text-[11px] uppercase tracking-[.25em] text-green-100/70 font-bold">Use code</p>
        <p className="promo-code my-3">{promo.code}</p>
        <button type="button" onClick={() => onCopy(promo.code)} className="btn-primary w-full">{copied ? <><Icon name="check" size={16} />Copied</> : 'Copy code'}</button>
      </div>
    </div>
  </article>
}
