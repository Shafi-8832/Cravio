# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Cravio is a food-delivery app built as coursework for CSE 216 (Database Management Systems). Express + PostgreSQL backend, React (Vite) frontend. There is no test suite; verification is done manually through the app or the Postman collections in `postman/`.

## Commands

Backend (`cd backend`, requires `.env` with `PORT`, `DATABASE_URL`, `JWT_SECRET`):

```bash
npm run dev          # nodemon server.js (default port 8000)
npm start            # node server.js
npm run seed:admin   # create an admin account (ADMIN_EMAIL/ADMIN_PASSWORD/... from .env)
```

Frontend (`cd frontend`):

```bash
npm run dev     # vite dev server; expects the API at http://localhost:8000
npm run build
npm run lint    # eslint
```

Database setup — order matters, and `schema.sql` starts with a `DROP TABLE ... CASCADE`, so applying it wipes all data:

```bash
psql "$DATABASE_URL" -f backend/db/schema.sql
psql "$DATABASE_URL" -f backend/db/functions/place_order.sql   # function + indexes; run after schema
```

## Architecture

### Roles drive everything

Four roles: `customer`, `restaurant_owner`, `rider`, `admin`. They are enforced in three places and all three must agree when adding a feature:

1. `backend/middleware/auth.js` (`authenticateToken`) → `backend/middleware/roleCheck.js` (`requireRole(...roles)`), composed per-route.
2. Row-level ownership checks inside each route/service (an owner may only touch their own restaurant's menu; a rider only their own delivery).
3. `RoleRoute` / `RoleAwareHome` in `frontend/src/App.jsx` — UX only, never the real gate.

`admin` cannot be created via `/api/auth/signup`; use `npm run seed:admin`.

Note: `backend/routes/roleCheck.js` is a stale duplicate of `backend/middleware/roleCheck.js` — routes import the middleware one.

### Auth: JWT with a revocation list

Login issues a JWT carrying a `jti`. `authenticateToken` verifies the signature and then runs **one** DB query joining `users` and `revoked_tokens`, so a revoked token (logout) and a suspended account (`users.is_active = false`) both take effect on the very next request rather than at next login. Logout inserts the `jti` into `revoked_tokens`.

Frontend counterpart is `frontend/src/utils/api.js`: a single axios instance whose request interceptor attaches the token from `localStorage`, and whose response interceptor clears storage and hard-redirects to `/login` on any 401 — except while already on `/login`, so a wrong-password error renders inline instead of reloading the page. `AuthContext` holds `user`/`login`/`logout`; `CartContext` holds cart state.

### Checkout lives in PostgreSQL

`place_order(...)` in `backend/db/functions/place_order.sql` is a plpgsql function that atomically validates the customer, branch, cart, and promo code, computes totals, and converts the cart into an order. It signals failures by raising named exceptions (`CART_EMPTY`, `BRANCH_CLOSED`, `PROMO_CODE_EXPIRED`, ...).

`backend/services/orderService.js` opens the transaction, calls the function, and maps each exception name through `CHECKOUT_ERROR_MAP` to an HTTP status + client-facing `code` + message. **To add a checkout rule, add the `RAISE` in the SQL function and its entry in `CHECKOUT_ERROR_MAP`** — the route layer (`routes/orders.js`) just forwards `OrderServiceError` via `sendError`.

Orders is the only domain with a service layer; the other routes query `pool` directly.

### Order and delivery state machines

Order status: `pending → confirmed → preparing → out_for_delivery → delivered`, plus `cancelled`. Owner-permitted transitions are whitelisted in `OWNER_STATUS_TRANSITIONS` (`orderService.js`) — owners only move `pending`/`confirmed` forward.

Delivery status is separate, in the `deliveries` table: `assigned → picked_up → delivered`, whitelisted in `routes/rider.js`. A rider accepting an order takes a row lock to avoid two riders claiming the same order, sets `orders.status = 'out_for_delivery'`, and inserts the `deliveries` row.

### Carts

One cart per `(user_id, restaurant_id)` — a customer can hold several carts at once, and cart endpoints are keyed by restaurant (`GET /api/cart/:restaurantId`) rather than by a single global cart. `place_order` rejects a cart mixing restaurants.

### API surface

Mounted in `backend/server.js` under `/api/{auth,restaurants,menu,cart,orders,rider,admin}`. Each route file documents its endpoints in `// METHOD /path` comments above the handler — grep those for the current map. In `routes/orders.js`, literal routes such as `/my-orders` are declared before `/:id` on purpose.

## Conventions

- Backend is CommonJS (`require`), frontend is ESM.
- Multi-statement writes use an explicit `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` with `client.release()` in `finally` (see signup in `routes/auth.js`).
- Always parameterize queries (`$1, $2`); the codebase has no string-interpolated SQL.
- Frontend API calls go through per-domain modules in `frontend/src/services/` that wrap the shared `utils/api.js` instance — don't call axios directly from a component.
- The existing code is heavily commented in an explanatory, learning-oriented style. Match the surrounding density rather than stripping or adding to it.


## Code style rules
- Keep code readable at an intermediate level — no clever one-liners, no
  unnecessary design patterns or abstraction layers just because they're possible.
- Write SQL as plain, explicit queries (not buried in heavy ORM magic) —
  we need to be able to read and explain every query for a presentation.
- Add short comments explaining *why*, especially around business logic,
  joins, and anything non-obvious.
- Structure: routes -> controllers -> db queries, kept flat and simple.
- Still hold professional standards: proper error handling, input
  validation, consistent naming — "simple" doesn't mean "sloppy."


## Academic project requirements (CSE216 Database Sessional — mandatory, graded)

### Database rules
- NO ORM of any kind. Use raw SQL via the `pg` library only. Never suggest
  Prisma, Sequelize, Knex, or query builders.
- Every query must be parameterized ($1, $2, ...). Never build SQL with
  string concatenation or template literals containing user input —
  this is graded as an SQL-injection defect.
- Every multi-step DML operation (insert+update, insert+insert, etc.)
  must use explicit transaction control: BEGIN, then COMMIT on success,
  ROLLBACK on any failure. Never rely on auto-commit for anything
  touching more than one table or more than one statement.
- The project must include, each tied to a real, sensible use case
  (not added just to tick a box):
  - At least 1 TRIGGER (e.g. auto-update a rating/count when a related
    row is inserted, or log a sensitive action to a shadow table)
  - At least 1 FUNCTION (returns a computed/statistical value, e.g.
    a restaurant's average rating or a user's total spend)
  - At least 1 PROCEDURE (a multi-step workflow modifying several
    tables in one operation, e.g. placing an order = insert order +
    insert order_items + update restaurant stats)
  - At least 3 "complex queries" — multi-table joins and/or aggregation
    functions, ideally surfaced as real features (e.g. "Top Restaurants",
    "Most Ordered Items")
- Don't add triggers/functions/procedures beyond what's justified —
  unnecessary ones are penalized as much as missing ones.

### Auth & authorization rules
- Auth is fully custom — no third-party auth service (no Auth0, Firebase
  Auth, Clerk, etc.)
- Passwords: bcrypt or argon2 with a per-user salt. Never plain text,
  never unsalted MD5/SHA1.
- Session management via JWT or server-side session with HTTP-only
  cookie — logout must genuinely invalidate it, not just redirect the
  frontend.
- Every route must check authentication before processing the request.
- A user's role is stored in the database and resolved server-side at
  login. NEVER trust a role sent from the client or hardcode it.
- Authorization is enforced in the backend, always:
  - No session/wrong role → 401 Unauthorized
  - Authenticated but wrong role for this action → 403 Forbidden
  - Object-level ownership checks required — e.g. a customer hitting
    /orders/17 must be blocked server-side if order 17 isn't theirs,
    even if they just guess the ID in the URL.
  - Hiding a button on the frontend is NOT authorization. The backend
    endpoint itself must reject it even via direct Postman/curl calls.

### API rules
- At least 20% of features must be exposed as REST endpoints with
  correct HTTP methods and status codes (200/201/204/400/401/403/404/409/500).
- Validate and sanitize all input server-side.

### Frontend rules
- Doesn't need to be visually polished, but must be fully functional:
  login/register/logout wired to real endpoints, role-aware views
  (different roles see different things), and visible error feedback
  (no silent failures).

## Code style rules
- Keep code readable at an intermediate level — no clever one-liners,
  no unnecessary abstraction layers.
- Write SQL as plain, explicit, parameterized queries — no ORM, no
  query-builder magic. We must be able to read and explain every query.
- Add short comments explaining *why*, especially around joins,
  triggers, functions, and procedures.
- We (the team) must understand and be able to write any part of this
  code by hand if asked during evaluation — never generate something
  we couldn't reproduce or explain ourselves.

## Documentation habit — docs/FLOW.md
Maintain and keep updated. For EVERY feature, write an entry in exactly
this format:

### <Feature name>
**Files involved:** list the actual file paths (frontend + backend + any
SQL/migration files)

**Flow (exam-level explanation):** Explain step by step, in plain
English, as if writing an answer for someone who needs to understand it
completely without looking anything up afterward. Rules:
- No unexplained technical terms. If a term like "middleware," "JWT,"
  "join," or "trigger" is used, explain what it means in one plain
  sentence right there — don't assume it's known.
- Short sentences. Say what happens first, second, third — like a
  numbered story, not a wall of text.
- End with the key SQL quer(ies) used in this feature and, in one
  sentence each, what each one is doing and why it's written that way.

Update this file every time a feature is added or changed — never let
it fall out of sync with the actual code.
