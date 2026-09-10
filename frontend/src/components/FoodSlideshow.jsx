import { useEffect, useState } from 'react'
import FoodImage from './FoodImage'

// A slow cross-fade between dishes. Every slide is stacked in the same
// grid cell and only opacity changes, so the panel never resizes and the
// layout cannot jump as pictures swap.
//
// The first slide is eager and the rest lazy: the hero should paint
// immediately, but there is no reason to spend bandwidth on picture six
// before anyone has seen picture one.
export default function FoodSlideshow({ slides, interval = 2400, className = '' }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused || slides.length < 2) return
    const timer = setInterval(() => setIndex(current => (current + 1) % slides.length), interval)
    return () => clearInterval(timer)
  }, [paused, slides.length, interval])

  // Respect the visitor's motion preference: if they have asked their
  // system to reduce animation, show one dish and leave it alone.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const apply = () => setPaused(query.matches)
    apply()
    query.addEventListener?.('change', apply)
    return () => query.removeEventListener?.('change', apply)
  }, [])

  return <div
    className={'relative grid ' + className}
    onMouseEnter={() => setPaused(true)}
    onMouseLeave={() => setPaused(false)}>
    {slides.map((slide, position) => <div
      key={slide.src}
      aria-hidden={position !== index}
      className="col-start-1 row-start-1 transition-opacity duration-500"
      style={{ opacity: position === index ? 1 : 0 }}>
      <FoodImage src={slide.src} alt={slide.alt} eager={position === 0} className="hero-photo w-full h-full object-cover" />
    </div>)}

    <div className="col-start-1 row-start-1 self-end justify-self-center mb-4 flex gap-2 z-10">
      {slides.map((slide, position) => <button
        key={slide.src}
        type="button"
        onClick={() => setIndex(position)}
        aria-label={'Show ' + slide.alt}
        aria-current={position === index}
        className={'h-2 rounded-full transition-all ' + (position === index ? 'w-6 bg-white' : 'w-2 bg-white/60 hover:bg-white/90')} />)}
    </div>

    <p className="sr-only" aria-live="polite">{slides[index]?.alt}</p>
  </div>
}
