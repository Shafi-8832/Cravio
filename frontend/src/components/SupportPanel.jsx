import { useCallback, useEffect, useState } from 'react'
import { getTickets, createTicket, updateTicket } from '../services/operationsApi'
import { errorMessage } from '../utils/format'

export default function SupportPanel({ admin = false }) {
  const [tickets, setTickets] = useState([])
  const [form, setForm] = useState({ subject: '', message: '', order_id: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [replies, setReplies] = useState({})
  const load = useCallback(async () => {
    try { setTickets((await getTickets()).data.tickets) } catch (err) { setError(errorMessage(err)) }
  }, [])
  // The effect starts remote I/O; load updates state after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { await createTicket({ ...form, order_id: form.order_id ? Number(form.order_id) : undefined }); setForm({ subject: '', message: '', order_id: '' }); await load() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  async function reply(ticket, status) {
    setBusy(true); setError('')
    try { await updateTicket(ticket.id, { status, admin_reply: replies[ticket.id] || ticket.admin_reply || '' }); await load() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return <section className="surface p-6 mt-6"><div className="flex justify-between gap-3 mb-5"><h2 className="text-xl font-bold">💬 {admin ? 'Support inbox' : 'How can we help?'}</h2><button onClick={load} className="text-sm text-orange-700">Refresh</button></div>{error && <p className="notice-error mb-4" role="alert">{error}</p>}
    {!admin && <form onSubmit={submit} className="grid sm:grid-cols-2 gap-3 mb-6"><label className="text-sm">Subject<input required minLength={3} maxLength={120} className="field mt-1" value={form.subject} onChange={event => setForm({ ...form, subject: event.target.value })} /></label><label className="text-sm">Order number (optional)<input type="number" min="1" className="field mt-1" value={form.order_id} onChange={event => setForm({ ...form, order_id: event.target.value })} /></label><label className="text-sm sm:col-span-2">What happened?<textarea required minLength={10} maxLength={4000} className="field mt-1" rows={3} value={form.message} onChange={event => setForm({ ...form, message: event.target.value })} /></label><button disabled={busy} className="btn-primary sm:col-span-2">Send support request</button></form>}
    {!tickets.length && <p className="text-sm muted">No support requests yet.</p>}
    <div className="space-y-4">{tickets.map(ticket => <article key={ticket.id} className="rounded-xl border border-stone-200 p-4"><div className="flex justify-between gap-3"><h3 className="font-bold">#{ticket.id} · {ticket.subject}</h3><span className="pill bg-stone-100 capitalize">{ticket.status.replaceAll('_', ' ')}</span></div>{admin && <p className="text-xs muted mt-1">{ticket.user_name} · {ticket.user_role}</p>}<p className="text-sm mt-3 whitespace-pre-wrap">{ticket.message}</p>{ticket.order_id && <p className="text-xs muted mt-2">Order #{ticket.order_id}</p>}{ticket.admin_reply && <p className="notice-success mt-3 whitespace-pre-wrap">Cravio support: {ticket.admin_reply}</p>}{admin && <div className="mt-3"><textarea aria-label={'Reply to ticket ' + ticket.id} className="field" placeholder="Write a reply…" maxLength={4000} value={replies[ticket.id] ?? ticket.admin_reply ?? ''} onChange={event => setReplies({ ...replies, [ticket.id]: event.target.value })} /><div className="flex gap-2 mt-2"><button disabled={busy} className="btn-secondary" onClick={() => reply(ticket, 'in_progress')}>In progress</button><button disabled={busy} className="btn-primary" onClick={() => reply(ticket, 'resolved')}>Resolve</button><button disabled={busy} className="btn-secondary" onClick={() => reply(ticket, 'open')}>Reopen</button></div></div>}</article>)}</div>
  </section>
}
