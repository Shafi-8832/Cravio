import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar } from '../components/DateRangePicker'
import { getOwnerReviews, getOwnerReviewSummary, replyToReview, deleteReviewReply } from '../services/ownerApi'
import { errorMessage } from '../utils/format'

const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['lowest', 'Lowest rated'],
  ['highest', 'Highest rated']
]

const PAGE_SIZE = 10

// Every review of this owner's restaurants, with a box to answer each one.
// The distribution at the top and the counts beside it were all computed by
// PostgreSQL — nothing on this page is counted in the browser.
export default function OwnerReviewsPage() {
  const [summary, setSummary] = useState(null)
  const [distribution, setDistribution] = useState([])
  const [reviews, setReviews] = useState([])
  const [pagination, setPagination] = useState(null)
  const [filters, setFilters] = useState({ rating: '', unreplied: false, sort: 'newest' })
  const [offset, setOffset] = useState(0)
  const [drafts, setDrafts] = useState({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, totals] = await Promise.all([
        getOwnerReviews({
          rating: filters.rating || undefined,
          unreplied: filters.unreplied ? 'true' : undefined,
          sort: filters.sort,
          limit: PAGE_SIZE,
          offset
        }),
        getOwnerReviewSummary()
      ])
      setReviews(list.data.reviews)
      setPagination(list.data.pagination)
      setSummary(totals.data.summary)
      setDistribution(totals.data.distribution)
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    } finally { setLoading(false) }
  }, [filters, offset])

  // The effect starts remote I/O; the state updates once the API answers.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  async function saveReply(review) {
    const draft = drafts[review.id] ?? review.owner_reply ?? ''
    setBusy(true); setError(''); setNotice('')
    try {
      await replyToReview(review.id, draft)
      setDrafts({ ...drafts, [review.id]: undefined })
      setNotice('Your reply has been published.')
      await load()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function removeReply(review) {
    setBusy(true); setError(''); setNotice('')
    try {
      await deleteReviewReply(review.id)
      setDrafts({ ...drafts, [review.id]: undefined })
      setNotice('Reply removed.')
      await load()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  function changeFilter(change) {
    setOffset(0)
    setFilters({ ...filters, ...change })
  }

  const maxCount = Math.max(0, ...distribution.map(row => row.review_count))
  const total = pagination?.total || 0

  return <main className="page-shell py-9">
    <div className="dashboard-heading flex justify-between items-center gap-3">
      <div>
        <p className="eyebrow mb-2">What your diners said</p>
        <h1 className="section-heading">Reviews ⭐</h1>
      </div>
      <Link className="btn-secondary" to="/owner">Back to the studio</Link>
    </div>

    {error && <p className="notice-error mb-5" role="alert">{error}</p>}
    {notice && <p className="notice-success mb-5" role="status">{notice}</p>}

    {/* The distribution, five stars down to one. */}
    <section className="surface p-5 mb-5">
      <div className="flex flex-wrap gap-8">
        <div>
          <p className="text-4xl font-extrabold">{summary?.average_rating ? Number(summary.average_rating).toFixed(2) : '—'}</p>
          <p className="text-sm muted mt-1">{summary?.total_reviews || 0} review{summary?.total_reviews === 1 ? '' : 's'}</p>
          <p className="text-sm muted">{summary?.unreplied_count || 0} awaiting a reply</p>
        </div>
        <div className="flex-1 min-w-[16rem]">
          {distribution.map(row => <div key={row.rating} className="flex items-center gap-3 text-sm py-1">
            <span className="w-10">{row.rating} ★</span>
            <span className="flex-1"><Bar value={row.review_count} max={maxCount} /></span>
            <span className="w-20 text-right muted">{row.review_count} · {row.share_pct ?? '0.0'}%</span>
          </div>)}
        </div>
      </div>
    </section>

    <div className="surface p-4 mb-5 flex flex-wrap items-center gap-4">
      <label className="text-sm">Rating
        <select className="field !w-auto ml-2" value={filters.rating}
          onChange={event => changeFilter({ rating: event.target.value })}>
          <option value="">All ratings</option>
          {[5, 4, 3, 2, 1].map(star => <option key={star} value={star}>{star} star{star === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <label className="text-sm">Sort
        <select className="field !w-auto ml-2" value={filters.sort}
          onChange={event => changeFilter({ sort: event.target.value })}>
          {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="text-sm flex items-center gap-2">
        <input type="checkbox" checked={filters.unreplied}
          onChange={event => changeFilter({ unreplied: event.target.checked })} />
        Only those I have not answered
      </label>
      <button className="btn-secondary ml-auto" onClick={load}>Refresh</button>
    </div>

    {loading && !reviews.length ? <p className="surface p-8">Loading reviews…</p>
      : !reviews.length ? <p className="surface p-8 text-sm muted">
        {total === 0 && !filters.rating && !filters.unreplied
          ? 'No reviews yet. They appear here once a delivered order is reviewed.'
          : 'No reviews match these filters.'}
      </p>
        : <div className="space-y-4">
          {reviews.map(review => {
            const draft = drafts[review.id] ?? review.owner_reply ?? ''
            return <article key={review.id} className="surface p-5">
              <div className="flex justify-between items-start gap-4 flex-wrap">
                <div>
                  <p className="font-bold">{'★'.repeat(review.rating)}<span className="text-stone-300">{'★'.repeat(5 - review.rating)}</span>
                    {/* First name only — that is all the API returns. */}
                    <span className="text-sm muted ml-2">{review.reviewer_first_name}</span>
                  </p>
                  <p className="text-xs muted mt-1">
                    Order #{review.order_id} · {review.restaurant_name} · {review.branch_name} · {new Date(review.created_at).toLocaleDateString()}
                  </p>
                </div>
                {review.owner_reply
                  ? <span className="pill bg-green-50 text-green-800">Replied</span>
                  : <span className="pill bg-yellow-50 text-yellow-800">Awaiting reply</span>}
              </div>

              <p className="mt-3 text-sm">{review.comment || 'A rating with no written comment.'}</p>

              <div className="mt-4 pt-4 border-t border-stone-100">
                <label className="text-sm font-semibold">Your reply
                  <textarea
                    className="field mt-1" rows={3} maxLength={1000}
                    placeholder="Answer this diner…"
                    value={draft}
                    onChange={event => setDrafts({ ...drafts, [review.id]: event.target.value })} />
                </label>
                <div className="flex items-center gap-3 mt-2">
                  <button className="btn-primary" disabled={busy || !draft.trim()} onClick={() => saveReply(review)}>
                    {review.owner_reply ? 'Update reply' : 'Publish reply'}
                  </button>
                  {review.owner_reply && <button className="btn-secondary" disabled={busy} onClick={() => removeReply(review)}>Remove reply</button>}
                  <span className="text-xs muted ml-auto">{draft.length}/1000</span>
                </div>
                {review.owner_replied_at && <p className="text-xs muted mt-2">
                  Last replied {new Date(review.owner_replied_at).toLocaleString()}
                </p>}
              </div>
            </article>
          })}
        </div>}

    {total > PAGE_SIZE && <div className="flex justify-center items-center gap-5 mt-6">
      <button className="btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}>Previous</button>
      <span className="text-sm">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
      <button className="btn-secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
    </div>}
  </main>
}
