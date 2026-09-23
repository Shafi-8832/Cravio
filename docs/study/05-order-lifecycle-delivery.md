# 05 — Order lifecycle, delivery & payments

## Files involved

**Frontend**
- `frontend/src/pages/MyOrdersPage.jsx` — the customer's order list, polled every 15s, with an expandable receipt.
- `frontend/src/components/OrderReceipt.jsx` — the receipt, timeline and the cancel / review actions.
- `frontend/src/pages/OwnerDashboardPage.jsx` — the Orders tab where an owner accepts, rejects or advances an order.
- `frontend/src/pages/RiderDashboardPage.jsx` — available jobs, claim, pickup, deliver.
- `frontend/src/services/orderApi.js`, `riderApi.js`, `operationsApi.js` — the wrappers.

**Route**
- `backend/routes/orders.js` — `GET /my-orders` (`:58`), `GET /restaurant` (`:76`), `GET /:id` (`:95`), `PATCH /:id/status` (`:115`), `PATCH /:id/cancel` (`:145`).
- `backend/routes/rider.js` — six routes, all behind `router.use(authenticateToken, requireRole('rider'))` at `:7`.
- `backend/routes/payments.js` — `GET /:orderId` (`:78`), `POST /:orderId/reference` (`:130`), `PATCH /:orderId/status` (`:258`).

**Controller**
- `backend/services/orderService.js` — `updateOrderStatus` (`:642`), `getOrderDetailsWithDb` (`:216`), `refundPromoUsage` (`:201`), the two transition tables at `:27` and `:35`.

**Middleware**
- `requireRole('restaurant_owner','admin')` on status (`orders.js:118`), `requireRole('customer')` on cancel (`:148`), `requireRole('rider')` on the whole rider router.

**SQL**
- `backend/db/functions/complete_delivery.sql` — the PROCEDURE, `CREATE` at `:3`.
- `backend/db/migrations/003_marketplace.sql:65-77` — `record_order_event()` and `trg_record_order_event`.
- `backend/db/schema.sql:411-476` — `orders` and its status CHECK; `:558-595` — `deliveries`; `:509-557` — `payments`.

---

## Flow

### The two state machines

**Order status** (`schema.sql:430-445`): `pending → confirmed → preparing → out_for_delivery → delivered`, plus `cancelled`.
**Delivery status** (`schema.sql:570-580`): `assigned → picked_up → delivered`. They are separate tables and separate machines that advance in step.

Who may move an order is whitelisted, not inferred:
- `OWNER_STATUS_TRANSITIONS` (`orderService.js:27-30`) — `pending → confirmed|cancelled`, `confirmed → preparing|cancelled`. **An owner cannot push an order past `preparing`**; from there it is the rider's.
- `CUSTOMER_STATUS_TRANSITIONS` (`orderService.js:35-38`) — `pending → cancelled`, `confirmed → cancelled`. The comment at `:32-34` explains the cut-off: once the order is `preparing` the food is already being made, so cancelling becomes the restaurant's call.

### Owner accepts or rejects

1. `PATCH /api/orders/:id/status` with `{ status }`.
2. `orders.js:117-118` — logged in, owner or admin.
3. `updateOrderStatus` (`orderService.js:642`): `:670` `BEGIN`, then `:676-689` loads the order **joined up to `restaurants.owner_id`**, `FOR UPDATE OF o` — the lock is taken on the order row only, not on the joined restaurant.
4. Not found → **404** (`:692`). Not your restaurant → **403** (`:708-711`).
5. `:719-731` looks the requested transition up in the table for this actor's role → **409 `INVALID_STATUS_TRANSITION`** if it is not permitted.
6. `:736` — confirming an order whose mobile payment is not yet verified → **409 `PAYMENT_NOT_VERIFIED`**.
7. `:743` — cancelling an already-paid order → **409 `REFUND_REQUIRED`**; the money must be dealt with by a human first.
8. `:747-755` performs the UPDATE. **`trg_record_order_event` fires here**, appending a timeline row.
9. If cancelling: `:759` gives the promo slot back and `:763-771` marks the unpaid payment `failed`.
10. `:774` re-reads the full order on the same client, `:777` COMMIT → **200**.

### Rider claims a job

1. `GET /api/rider/deliveries/available` (`rider.js:42`) lists claimable orders. **The customer's address is not in that payload** — it is disclosed only after acceptance.
2. `POST /api/rider/deliveries/:orderId/accept` (`:66`): `:71` `BEGIN`, then `:73` locks *this rider's own profile* `FOR UPDATE` — that is what stops one rider claiming two jobs at once.
3. Rider not `online` → **409** (`:76`). `:78` locks the order; missing → **404**.
4. `:83-85` checks in one go that nobody else has claimed it, that this rider has no other active delivery, and that the payment is either cash or already paid → **409** (`:88`).
5. `:91-95` inserts the `deliveries` row, sets `orders.rider_id`, flips the rider to `busy`, and writes an `order_events` note. `:96` COMMIT → **201**.

### Rider picks up and delivers

1. `PATCH /api/rider/deliveries/:orderId/status` with `picked_up` or `delivered` (`rider.js:104`).
2. `:110` `BEGIN`, then three `FOR UPDATE` locks in a fixed order — profile, order, delivery (`:111-113`).
3. **Ownership:** `delivery.rider_id !== req.user.id` → **403**; no delivery row at all → **404** (`:115-118`).
4. `:119-121` enforces the delivery machine → **409**.
5. `picked_up` → two plain UPDATEs (`:128-129`). `delivered` → **`CALL complete_delivery($1,$2)`** (`:126`).
6. `:131` COMMIT → **200**.

### Payments

- `GET /api/payments/:orderId` (`:78`) — see unit 02 and the Task C note: `authenticateToken` only, ownership hand-checked at `:99-102`.
- `POST /api/payments/:orderId/reference` (`:130`) — the customer records a bKash/Nagad transaction reference. `BEGIN` at `:162`, ownership at `:174`, → **200**.
- `PATCH /api/payments/:orderId/status` (`:258`) — the **owner or admin** marks it paid or failed. `BEGIN` at `:281`, ownership at `:293`. Cash is refused here (`:301`) because cash is settled by the procedure, and an already-paid payment is refused (`:305`). The client can never declare its own payment settled — that is the whole reason this step is owner-restricted (`payments.js:22-23`).

---

## The SQL

**1. Load the order for a status change** — `orderService.js:676-688`
```sql
          o.status,
          o.customer_id,
          o.promo_code_id,
          r.owner_id
        FROM orders o
        JOIN restaurant_branches rb
          ON rb.id = o.branch_id
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        WHERE o.id = $1
        FOR UPDATE OF o
```
`$1` = order id. The two joins climb order → branch → restaurant so `owner_id` is available for the ownership test. **`FOR UPDATE OF o`** locks only the order row — locking the restaurant too would serialise every order that restaurant has.

**2. Advance the status** — `orderService.js:747-752`
```sql
UPDATE orders
SET status = $1
WHERE id = $2
```
`$1` the new status (already proved legal by the transition table), `$2` the order id. **This statement fires `trg_record_order_event`.**

**3. Give the promo slot back** — `orderService.js:206-212`
```sql
UPDATE promo_codes
SET used_count = GREATEST(used_count - 1, 0)
WHERE id = $1
```
`$1` = the order's `promo_code_id`. `GREATEST(…, 0)` makes it impossible to drive the counter negative if it is ever called twice. Runs in the same transaction as the cancellation, so the slot and the cancellation both land or neither does.

**4. Fail the unpaid payment on cancellation** — `orderService.js:764-770`
```sql
UPDATE payments
SET status = 'failed'
WHERE order_id = $1
  AND status = 'unpaid'
```
`$1` order id. `AND status = 'unpaid'` makes it a no-op on an already-settled payment. The comment at `:760-762` gives the reason: an `unpaid` row on a cancelled order is indistinguishable from one still awaiting settlement in any report.

**5. The audit trigger** — `003_marketplace.sql:65-77`
```sql
CREATE OR REPLACE FUNCTION record_order_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_events(order_id, status, note) VALUES (NEW.id, NEW.status, 'Order placed');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_events(order_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_record_order_event ON orders;
CREATE TRIGGER trg_record_order_event AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION record_order_event();
```
`IS DISTINCT FROM` rather than `<>` so a NULL on either side still counts as a change. `UPDATE OF status` narrows it to status changes. The comment at `:63-64` makes the key point: **the trigger covers updates made by the delivery procedure, not only by Express routes** — so the timeline is complete no matter who moved the order.

**6. Claim a delivery** — `rider.js:91-95`
```sql
INSERT INTO deliveries(order_id,rider_id,delivery_status)
      VALUES ($1,$2,'assigned') RETURNING *
```
then, in the same transaction,
```sql
UPDATE orders SET rider_id=$1 WHERE id=$2
UPDATE rider_profiles SET status='busy' WHERE user_id=$1
INSERT INTO order_events(order_id,status,note) VALUES ($1,'preparing','Rider assigned; waiting for pickup')
```
Four writes across three tables. `$1`/`$2` are the rider id from the token and the order id from the URL. Note the last one writes an `order_events` row **by hand**, because the order's *status* has not changed — the trigger would not fire.

**7. THE PROCEDURE — `complete_delivery`** — `complete_delivery.sql:3-30`
```sql
CREATE OR REPLACE PROCEDURE complete_delivery(p_order_id INTEGER, p_rider_id INTEGER)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_delivery deliveries%ROWTYPE;
BEGIN
  PERFORM 1 FROM rider_profiles WHERE user_id = p_rider_id FOR UPDATE;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  SELECT * INTO v_delivery FROM deliveries WHERE order_id = p_order_id FOR UPDATE;
  IF v_delivery.id IS NULL OR v_delivery.rider_id <> p_rider_id THEN
    RAISE EXCEPTION 'DELIVERY_NOT_ASSIGNED';
  END IF;
  IF v_delivery.delivery_status <> 'picked_up' OR v_order.status <> 'out_for_delivery' THEN
    RAISE EXCEPTION 'INVALID_DELIVERY_TRANSITION';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order_id
             AND method <> 'cash_on_delivery' AND status <> 'paid') THEN
    RAISE EXCEPTION 'PAYMENT_NOT_VERIFIED';
  END IF;
  UPDATE deliveries SET delivery_status = 'delivered', delivery_time = CURRENT_TIMESTAMP
    WHERE order_id = p_order_id;
  UPDATE orders SET status = 'delivered', review_eligible = true WHERE id = p_order_id;
  UPDATE payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP
    WHERE order_id = p_order_id AND method = 'cash_on_delivery' AND status = 'unpaid';
  UPDATE rider_profiles SET status = 'online' WHERE user_id = p_rider_id;
END;
$$;
```
**This is the project's PROCEDURE, and it earns the name**: four tables updated as one indivisible act. Handing over the food simultaneously marks the delivery done, marks the order delivered **and review-eligible**, settles the cash, and frees the rider. Do any of those separately and a crash between them leaves a rider stuck `busy`, or an order delivered but never payable, or a customer unable to review food they received.

`SECURITY INVOKER` means it runs with the caller's privileges, not the definer's — it is not a privilege-escalation hatch. `SET search_path = public, pg_temp` pins schema resolution so it cannot be hijacked by a malicious `search_path`. The three `FOR UPDATE` locks are taken in the same order as every other delivery write (`rider.js:111-113`), which is how deadlocks are avoided.

**8. Payment reference and settlement** — `payments.js:219`, `:336`
```sql
UPDATE payments
SET transaction_ref = ...
```
```sql
UPDATE payments
SET status = ...
```
Both `WHERE order_id = $1`, both inside their route's transaction, both preceded by a row lock via `findPaymentForOrder(client, orderId, true)` (`payments.js:29-33`).

---

## Transactions

| Operation | BEGIN | COMMIT | Notes |
|---|---|---|---|
| `updateOrderStatus` (status + cancel) | `orderService.js:670` | `:777` | Contains: the locking SELECT, the status UPDATE, **the audit trigger**, the promo refund, the payment-fail UPDATE, and the read-back at `:774`. ROLLBACK `:780`, release `:783`. |
| Rider accept | `rider.js:71` | `:96` | Four writes, three tables, plus three locks. ROLLBACK `:98`. |
| Rider status / deliver | `rider.js:110` | `:131` | Wraps **`CALL complete_delivery`** (`:126`), so the procedure's four updates join the route's transaction. |
| Payment reference | `payments.js:162` | — | ROLLBACK on every early return. |
| Payment status | `payments.js:281` | — | Same. |

The layering point worth saying out loud: **`complete_delivery` contains no `BEGIN` of its own.** A procedure invoked with `CALL` inside an open transaction runs within it. That is deliberate — it means the rider route can do other work in the same atomic unit, and a failure after the `CALL` still unwinds the procedure's four updates.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Status changed (`orders.js:127`), cancelled (`:157`), delivery advanced (`rider.js:132`), payment reference or status updated. |
| **201** | Delivery claimed (`rider.js:97`). |
| **400** | Bad order id, or a `status` outside `picked_up`/`delivered` (`rider.js:107`); `status` not `paid`/`failed` (`payments.js:272`). |
| **401 / 403** | Standard gates; **403** also for an order that is not your restaurant's (`orderService.js:710`), a delivery not assigned to you (`rider.js:117`), a payment that is not yours (`payments.js:103`, `:177`, `:293`). |
| **404** | Order not found (`orderService.js:692`), delivery row absent (`rider.js:117`), payment not found (`payments.js:94`, `:169`, `:288`). |
| **409** | `INVALID_STATUS_TRANSITION` (`orderService.js:726`), `PAYMENT_NOT_VERIFIED` (`:736`), `REFUND_REQUIRED` (`:743`), rider offline or busy (`rider.js:76`), order not claimable (`rider.js:88`), delivery out of sequence (`rider.js:121`), `METHOD_IS_CASH` (`payments.js:303`), `ALREADY_PAID` (`:307`). |
| **500** | Unexpected failure, via `sendError` / the global handler at `server.js:94-100`. |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **PROCEDURE** | `complete_delivery` (`complete_delivery.sql:3`). A genuine multi-step workflow — deliveries, orders, payments, rider_profiles in one call — exactly the rubric's description. |
| **TRIGGER** | `trg_record_order_event` (`003_marketplace.sql:76-77`), maintaining an audit trail of every status change including those made by the procedure. |
| **Explicit transaction** | Five, listed above. The rider-deliver one wraps a `CALL` and is the strongest demonstration in the project. |
| **Object-level ownership** | Owner via the join to `owner_id` (`orderService.js:679-685`); rider via `delivery.rider_id` (`rider.js:115`); customer via `o.customer_id` (`orderService.js:222`). |
| **Role authorization** | Three different role sets across five routes; the two transition tables make the *same* endpoint behave differently per role. |
| **Complex query** | The order-details read (`orderService.js:234-268`) joins orders, users, branches, restaurants and promo_codes, then fetches items, payment, delivery and timeline. |

---

## Likely viva questions

**1. Why is `complete_delivery` a procedure and not four UPDATEs in the route?**
Because those four updates are one business event. If the route did them separately and crashed after the second, you would have an order marked delivered with the rider still `busy` and the cash never settled. Wrapping them in a procedure means one `CALL` either does all four or none. It also keeps the locking discipline in one place: the procedure takes profile, order, delivery locks in a fixed order (`:10-12`), the same order the route uses, so deliveries never deadlock against each other.

**2. Your procedure has no BEGIN/COMMIT. Isn't that a missing transaction?**
No — a procedure invoked with `CALL` runs inside whatever transaction the caller has open, and `rider.js:110` opens one before calling it at `:126`. That is deliberate: the route can do other work in the same atomic unit. If the procedure opened its own transaction, the route's surrounding work could not be rolled back with it.

**3. Why can't an owner mark an order delivered?**
`OWNER_STATUS_TRANSITIONS` (`orderService.js:27-30`) stops at `preparing`. Beyond that the order belongs to the rider's machine — `out_for_delivery` is set when a rider picks up (`rider.js:129`), and `delivered` only by `complete_delivery`, which first checks the caller is the assigned rider. A restaurant cannot mark food delivered that it never carried.

**4. A customer cancels an order they already paid for. What happens? (design justification)**
They get **409 `REFUND_REQUIRED`** (`orderService.js:743`). We deliberately refuse rather than auto-refunding, because this project has no payment-gateway integration — `payments.status` is a record of a human reconciliation, not a live settlement. Silently marking a paid order cancelled would leave real money unaccounted for. The alternative designs were auto-refund (impossible without a gateway) or allowing the cancel and flagging it (leaves the books wrong until someone notices). Refusing forces the conversation.

**5. Where does the order timeline come from, and why a trigger rather than writing it in the route?**
`order_events`, maintained by `trg_record_order_event`. A trigger, because the order status is changed from three different places — `place_order`'s INSERT, `updateOrderStatus`, and `complete_delivery` — and a route-level audit would miss the procedure entirely. The comment at `003_marketplace.sql:63-64` says exactly that. The one gap is that a rider *claiming* a job does not change the order's status, so `rider.js:95` writes that event by hand.

---

## Gaps and defects

**DML with no transaction**
- None in this slice. All five writing paths open one explicitly.

**Ownership bypassable via an id in the URL or body**
- None found. Every route takes the order id from the URL but always pairs it with `req.user.id`: the owner path joins to `owner_id` (`orderService.js:685`), the rider path compares `delivery.rider_id` (`rider.js:115`), the customer path adds `o.customer_id = $n` (`orderService.js:222`).
- Two observations, not holes: `GET /api/payments/:orderId` has no `requireRole` (see Task C); and `PATCH /api/orders/:id/status` allows `admin`, so an admin can move any restaurant's order — intended, but it means the 403 at `:708-711` is skipped entirely for admins (`:707`).

**SQL built by string concatenation**
- None. `orderService.js:222`/`:225` interpolate only `$${values.length}` — a placeholder number. `rider.js:132` and `payments.js:329`/`:357` interpolate into **error message strings**, not SQL.

**Other defects**

1. **The assigned rider cannot read the payment for their own delivery.** `findPaymentForOrder` never selects `o.rider_id` (`payments.js:36-54`), and the check at `:99-102` only considers customer, owner and admin — so even the rider carrying a cash order gets a 403. Not a security hole (the rider's own list at `rider.js:54-64` already joins `payments`), but the endpoint's comment at `:76` says "The order's customer, the restaurant owner, or an admin" and the rider's absence looks accidental rather than reasoned.
2. **A cancelled order's delivery row is left untouched.** `updateOrderStatus` fails the payment and refunds the promo but never updates `deliveries`. An order cancelled after a rider claimed it leaves a delivery row `assigned` forever and — worse — the rider's profile stuck at `busy`, because only `complete_delivery` sets it back to `online`. The rider has no route to free themselves: `PATCH /api/rider/profile` refuses while `status='busy'` (`rider.js:25`).
3. **`order_events` is never pruned** and every order accumulates rows for life. It is read on every receipt (`orderService.js:353`).
4. **The rider-assigned timeline note is hand-written** (`rider.js:95`) with the status string `'preparing'` — a value that is not a transition, just the current status repeated. If the order's real status ever differs at that moment, the timeline records something untrue.
5. **Two sources of truth for "is this paid".** `payments.status` is authoritative, but `complete_delivery:26-27` settles cash while `payments.js:258` settles mobile money, and `orderService.js:736` reads it for a third purpose. Three places encode "verified"; a change to the rule needs all three.
6. **`GET /api/orders/:id` allows admin with no restriction at all** (`orderService.js:226`), which is correct but means the same endpoint has three quite different security postures depending on role — easy to get wrong when extending.

---

## Explain-it-in-60-seconds

There are two state machines, not one. The order goes pending → confirmed → preparing → out_for_delivery → delivered, and the delivery goes assigned → picked_up → delivered. Who's allowed to make each move is whitelisted in a table, not inferred: an owner can only go pending→confirmed→preparing, and a customer can only cancel while it's pending or confirmed — once it's preparing, the food is being cooked, so cancelling is the restaurant's call.

Every status change is one transaction. We lock the order row FOR UPDATE, climb the join to the restaurant to check ownership, look the requested move up in the transition table, then update. The moment that update lands, a trigger writes a row into `order_events` — that's the timeline. It's a trigger rather than route code because three different things change order status: the checkout function, the status route, and the delivery procedure. Route-level auditing would miss the procedure.

The delivery finish is the interesting one. When a rider marks delivered, the route opens a transaction and does `CALL complete_delivery`. That procedure locks the rider profile, order and delivery in a fixed order, checks the rider is actually assigned and the sequence is right, and then does four updates as one act: delivery delivered, order delivered *and* review-eligible, cash marked paid, rider freed back to online. If you did those separately and crashed halfway, you'd get a rider stuck busy or food delivered that can never be paid for. The procedure has no BEGIN of its own — CALL runs inside the caller's transaction, which is exactly what we want.

One honest gap: cancelling an order after a rider has claimed it doesn't clear the delivery or free the rider, so that rider stays busy with no way out.
