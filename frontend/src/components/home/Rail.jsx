import { useRef } from 'react'
import Icon from '../Icon'

// One horizontal rail on the home page: a heading, arrow buttons (desktop)
// and a row of cards that scrolls sideways and snaps card by card (CSS
// scroll-snap, so it is swipeable on phones without any library).
//
// States:
//   loading          -> grey placeholder cards (skeletons)
//   error            -> the server's message, never a silent blank
//   no items at all  -> the whole section is hidden (e.g. Order Again for a
//                       brand-new customer)
export default function Rail({ eyebrow, title, subtitle, loading, error, count, cardWidth = 250, children }) {
  const trackRef = useRef(null)

  if (!loading && !error && count === 0) return null

  // Scroll by most of the visible width, so one click shows the next few cards.
  function scrollRail(direction) {
    const track = trackRef.current
    if (track) track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: 'smooth' })
  }

  return <section className="mt-11" aria-label={title}>
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h2 className="section-heading !text-2xl">{title}</h2>
        {subtitle && <p className="text-sm text-stone-500 mt-1">{subtitle}</p>}
      </div>
      {!loading && !error && count > 1 && <div className="hidden sm:flex gap-2">
        <button type="button" onClick={() => scrollRail(-1)} className="rail-arrow" aria-label={'Scroll ' + title + ' left'}><Icon name="chevron" size={18} className="rotate-180" /></button>
        <button type="button" onClick={() => scrollRail(1)} className="rail-arrow" aria-label={'Scroll ' + title + ' right'}><Icon name="chevron" size={18} /></button>
      </div>}
    </div>
    {error
      ? <p role="alert" className="notice-error">{error}</p>
      : <div ref={trackRef} className="rail-track flex gap-5 overflow-x-auto snap-x snap-mandatory pb-3 -mx-5 px-5 md:mx-0 md:px-0">
        {loading
          ? [1, 2, 3, 4, 5].map(key => <div key={key} className="shrink-0" style={{ width: cardWidth }} aria-hidden="true">
            <div className="skeleton h-40 rounded-2xl" />
            <div className="skeleton h-4 rounded-md mt-3 w-3/4" />
            <div className="skeleton h-3 rounded-md mt-2 w-1/2" />
            <div className="skeleton h-5 rounded-md mt-3 w-1/3" />
          </div>)
          : children}
      </div>}
  </section>
}
