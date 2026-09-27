import { useCallback, useEffect, useRef, useState } from 'react'
import { getReviewSummary, getReviewPage } from '../services/restaurantApi'
import { errorMessage } from '../utils/format'

// How many reviews one request fetches. The server caps limit at 50, so this
// stays well under it; "Load more" asks for the next PAGE_SIZE rows.
const PAGE_SIZE = 10

// A right-hand drawer showing one restaurant's rating breakdown and reviews.
//
// Built on the native <dialog> element, the same choice as components/Modal.jsx,
// because the browser then supplies three things for free: Escape closes it
// (fires the `cancel` event), focus stays inside it while open, and the page
// behind it gets a real backdrop. The only thing <dialog> does not give us is
// closing on a backdrop click, which is added by hand below.
export default function ReviewsDrawer({ restaurantId, restaurantName, onClose }) {
  const ref = useRef(null)
  const [summary, setSummary] = useState(null)
  const [reviews, setReviews] = useState([])
  const [pagination, setPagination] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  // showModal() is what makes the dialog modal — without it the element is
  // inert and invisible. The cleanup closes it and hands focus back to
  // whatever was focused before (the rating button), so keyboard users are
  // not dumped at the top of the page.
  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement
    dialog.showModal()
    return () => { dialog.close(); previous?.focus() }
  }, [])

  // First load: the breakdown and the first page of reviews together, since
  // neither depends on the other and one round trip feels faster than two.
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const [head, page] = await Promise.all([
          getReviewSummary(restaurantId),
          getReviewPage(restaurantId, { limit: PAGE_SIZE, offset: 0 })
        ])
        if (!active) return
        setSummary(head.data)
        setReviews(page.data.reviews)
        setPagination(page.data.pagination)
        setError('')
      } catch (err) {
        // Shown inside the drawer rather than swallowed, so a 401 (not signed
        // in) or a 500 tells the visitor what happened instead of leaving an
        // empty panel that looks broken.
        if (active) setError(errorMessage(err, 'Could not load reviews.'))
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [restaurantId])

  // "Load more" asks for the rows after the ones already on screen. The offset
  // is the number of reviews currently held, so the server's stable ordering
  // (created_at DESC, id DESC) hands back the next slice without repeating or
  // skipping any.
  const loadMore = useCallback(async () => {
    setLoadingMore(true)
    try {
      const page = await getReviewPage(restaurantId, { limit: PAGE_SIZE, offset: reviews.length })
      setReviews(current => [...current, ...page.data.reviews])
      setPagination(page.data.pagination)
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Could not load more reviews.'))
    } finally {
      setLoadingMore(false)
    }
  }, [restaurantId, reviews.length])

  const total = summary?.total_reviews ?? 0

  return <dialog
    ref={ref}
    aria-label={`Reviews for ${restaurantName}`}
    onCancel={onClose}
    // A click on a <dialog> whose target is the dialog element itself landed on
    // the backdrop, not on any child, so that is the backdrop-click test.
    onClick={event => { if (event.target === ref.current) onClose() }}
    className="!m-0 !ml-auto h-full max-h-full w-[min(94vw,440px)] rounded-none rounded-l-2xl p-0 backdrop:bg-black/40">

    <div className="flex h-full flex-col bg-white">
      <header className="flex items-start justify-between gap-4 border-b border-stone-200 p-5">
        <div>
          <h2 className="text-xl font-extrabold">Ratings &amp; reviews</h2>
          <p className="text-sm muted mt-1">{restaurantName}</p>
        </div>
        <button onClick={onClose} aria-label="Close reviews" className="icon-button text-lg leading-none">✕</button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        {error && <p className="notice-error mb-4" role="alert">{error}</p>}

        {loading ? <p className="text-sm muted">Loading reviews…</p> : <>

          {summary && <section className="mb-6">
            <p className="text-4xl font-extrabold">
              {summary.average_rating == null ? '—' : Number(summary.average_rating).toFixed(1)}
              <span className="text-lg font-semibold text-stone-400"> / 5</span>
            </p>
            {/* Pluralisation: "1 review" but "2 reviews". */}
            <p className="text-sm muted mt-1">{total} {total === 1 ? 'review' : 'reviews'}</p>

            {/* 5 down to 1. The server already returns them in that order and
                already computed each bar's share, so this only draws. */}
            <div className="mt-4 space-y-1.5">
              {summary.breakdown.map(row => <div key={row.star} className="flex items-center gap-3 text-sm">
                <span className="w-8 shrink-0 tabular-nums">{row.star} ★</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                  <span
                    className="block h-full rounded-full bg-orange-500"
                    style={{ width: `${Number(row.share_pct ?? 0)}%` }} />
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums muted">{row.review_count}</span>
              </div>)}
            </div>
          </section>}

          <section className="space-y-4 border-t border-stone-200 pt-5">
            {reviews.map(review => <article key={review.id} className="border-b border-stone-100 pb-4 last:border-0">
              <p className="font-bold">
                {'★'.repeat(review.rating)}<span className="text-stone-300">{'★'.repeat(5 - review.rating)}</span>
                <span className="ml-2 text-sm muted">{review.reviewer_name}</span>
              </p>
              <p className="text-xs muted mt-1">{new Date(review.created_at).toLocaleDateString()}</p>
              <p className="mt-2 text-sm">{review.comment || 'A rating from a delivered order.'}</p>
              {review.owner_reply && <div className="mt-3 border-l-2 border-orange-300 pl-3">
                <p className="text-xs font-bold text-orange-700">Reply from {restaurantName}</p>
                <p className="mt-1 text-sm">{review.owner_reply}</p>
              </div>}
            </article>)}

            {!reviews.length && !error && <p className="text-sm muted">No reviews yet.</p>}

            {pagination?.has_more && <button
              className="btn-secondary w-full"
              disabled={loadingMore}
              onClick={loadMore}>
              {loadingMore ? 'Loading…' : `Load more (${total - reviews.length} left)`}
            </button>}
          </section>
        </>}
      </div>
    </div>
  </dialog>
}
