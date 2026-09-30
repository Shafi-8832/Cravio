# Cravio

A food-delivery web app: customers order from restaurants, owners run their
menus and orders, riders take deliveries, and an admin oversees the platform.

<!-- screenshot here -->

## Stack

React + Vite frontend, Express backend, PostgreSQL accessed with raw SQL over
`pg`, custom JWT authentication.

## Features

- **Customer** — browse and search restaurants, filter by division and
  cuisine, build a cart with menu modifiers, check out with a promo code and
  cash on delivery, watch the rider on a live map, and review a delivered
  order.
- **Restaurant owner** — manage restaurants, branches, opening state and map
  pins; build the menu with categories, dishes and choice groups; accept and
  progress incoming orders; read analytics and reply to reviews.
- **Rider** — go online, claim an available delivery, share GPS position while
  on the road, move the delivery through pickup and drop-off, and collect cash.
- **Admin** — manage and suspend accounts, watch every delivery in progress on
  one board, read platform analytics, run promo codes and answer support
  tickets.

## Course project

Cravio was built as the CSE 216 (Database Sessional) course project at BUET.
The course required raw SQL with no ORM, explicit transaction control on every
write, and database-side triggers, functions and procedures — which is why
checkout is a PostgreSQL function, delivery completion is a procedure,
restaurant ratings are maintained by a trigger, and every write route opens its
own transaction.

Requirement-to-code map: [docs/COURSE-REQUIREMENTS.md](docs/COURSE-REQUIREMENTS.md).
The checklist itself: [docs/course-checklist.md](docs/course-checklist.md).

## Quick start

```bash
npm run setup       # writes backend/.env and frontend/.env with a generated JWT secret
npm run db:migrate  # creates the schema, then applies migrations, functions and triggers
npm run dev:api     # API on :8000 — then `npm run dev:web` in a second terminal for :5173
```

Needs PostgreSQL and `npm ci --prefix backend`, `npm ci --prefix frontend`
first. Full instructions, including seeding and an admin account:
[docs/SETUP.md](docs/SETUP.md).

## Architecture

Four roles (`customer`, `restaurant_owner`, `rider`, `admin`) drive everything.
Every request carries a JWT that the backend re-checks against the database, a
`requireRole(...)` middleware guards each route, and each handler also confirms
the object being touched belongs to the caller. The frontend routes by role too,
but only for the interface — the API rejects a wrong-role or wrong-owner call
even when made directly with curl. Orders are the one domain with a service
layer; the other routes query the pool directly. Endpoint reference:
[docs/API.md](docs/API.md). Schema, triggers, functions and procedures:
[docs/DATABASE.md](docs/DATABASE.md).

## Notable implementation details

- **Prices are computed server-side.** Cart and order totals are calculated
  from database prices; a client-supplied amount is never trusted.
- **Restaurant ratings are stored, not computed per read.** A trigger on
  `restaurant_reviews` recomputes `avg_rating` and `review_count` in the same
  transaction as the review change, so application code never writes them.
- **Every write route runs in an explicit transaction** — `BEGIN`, `COMMIT`,
  `ROLLBACK` on failure — and concurrency is handled with `SELECT ... FOR
  UPDATE` row locks rather than application-level checks.
- **Logout is real.** Each JWT carries a `jti`; logging out inserts it into a
  `revoked_tokens` table that is joined on every authenticated request, so the
  token stops working immediately instead of at expiry.
- **Raw parameterised SQL throughout.** No ORM and no query builder; every
  value is bound as `$1, $2, …`.
- **Distance and ETA are computed in SQL** by a `distance_km()` Haversine
  function, so "within 5 km, closest first" is filtered and sorted in the
  database.

## More documentation

- [docs/FLOW.md](docs/FLOW.md) — step-by-step walkthrough of each feature
- [docs/live-tracking.md](docs/live-tracking.md) — the map and live rider tracking
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — restaurant catalogue, photo credits, Google Places
- [docs/REVIEW.md](docs/REVIEW.md) — what is implemented and what a real deployment would still need

## License

[MIT](LICENSE)
