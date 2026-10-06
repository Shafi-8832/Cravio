<!-- Header banner: colours are Cravio's own orange (#EA580C) and amber (#F59E0B). -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:EA580C,100:F59E0B&height=110&section=header" width="100%" alt="" />

<div align="center">

<img src="frontend/src/assets/brand/cravio-logo.png" alt="Cravio logo" width="190" />

# Cravio

### Cravings, delivered.

A full-stack food-delivery platform for Bangladesh: customers order, kitchens cook, riders deliver and admins keep it all running. It is built on PostgreSQL with hand-written SQL.

<a href="https://cravio-rho.vercel.app">
  <img src="https://readme-typing-svg.demolab.com?font=Manrope&weight=700&size=20&duration=2600&pause=900&color=EA580C&center=true&vCenter=true&width=620&lines=Live+deals+and+restaurants+near+you;Order+in+a+few+taps%2C+pay+cash+on+delivery;Follow+your+rider+live+on+the+map;Four+roles%2C+one+PostgreSQL+database" alt="Live deals and restaurants near you · Order in a few taps · Follow your rider live · Four roles, one database" />
</a>

<br />

![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite_8-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express_5-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL_16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-199900?style=for-the-badge&logo=leaflet&logoColor=white)

[![Live demo](https://img.shields.io/badge/Live_demo-cravio--rho.vercel.app-EA580C?style=flat-square&logo=vercel&logoColor=white)](https://cravio-rho.vercel.app)
[![Watch the demo](https://img.shields.io/badge/Watch-5--min_demo_film-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://youtu.be/Y4EMKCs3_pI)
[![Course](https://img.shields.io/badge/CSE_216-Database_Sessional_·_BUET-173B32?style=flat-square)](#team-and-acknowledgments)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B?style=flat-square)](LICENSE)

</div>

---

## Table of contents

- [Demo](#demo)
- [About](#about)
- [Feature showcase](#feature-showcase)
- [Four roles](#four-roles)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Database design](#database-design)
- [Security](#security)
- [API overview](#api-overview)
- [Getting started](#getting-started)
- [Demo accounts](#demo-accounts)
- [Project structure](#project-structure)
- [Team and acknowledgments](#team-and-acknowledgments)

---

## Demo

<div align="center">

<a href="https://youtu.be/Y4EMKCs3_pI">
  <img src="https://img.youtube.com/vi/Y4EMKCs3_pI/maxresdefault.jpg" alt="Watch the Cravio demo film on YouTube" width="760" />
</a>

<sub><b>Click to watch the demo film on YouTube.</b> One real KFC order follows four people, and every other feature is covered along the way.</sub>

<br /><br />

<img src="docs/screenshots/intro.gif" alt="Cravio's opening animation revealing the live home page" width="560" />

<sub>The landing intro ("The Reveal") opens onto the live deals and the restaurant list.</sub>

</div>

> **Try it live:** [cravio-rho.vercel.app](https://cravio-rho.vercel.app). The API runs on Render's free tier, so the first request after a quiet period can take up to a minute to wake it.

---

## About

Cravio is a food-delivery app for Bangladesh. Customers browse live deals, order from restaurants near them and watch their rider on a map. Restaurant owners run menus, branches and incoming orders; riders claim deliveries and share their location; an admin team oversees the platform.

We built it for **CSE 216 (Database Sessional) at BUET**. The team is **Md Atik Khan** and **Ahnaf Ahmed Safi**.

We chose to use **no ORM**. Every query is hand-written, parameterised SQL sent through the `pg` driver. The rules that must never break live inside PostgreSQL itself: checkout is a database function, delivery completion is a stored procedure, and ratings, order history and status changes are guarded by triggers. Whichever code path touches the data, those rules still hold.

---

## Feature showcase

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/home.png" alt="Home page with Today's deals and Popular right now" />
      <p><b>Live deals home page</b><br/>Today's deals count down to their end time and vanish when they expire. "Popular right now" ranks the dishes ordered most in the last seven days. Guests see the same live page before signing up.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/live-tracking.gif" alt="Customer map following the rider" width="300" />
      <p><b>Live rider tracking</b><br/>Once the food is picked up, the customer's map follows the rider along the road, with the distance left and an ETA. The page refreshes every five seconds.</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/near-me.png" alt="Restaurants near you map and list" width="300" />
      <p><b>Restaurants near you</b><br/>"Near me" uses the phone's location to map the branches within a chosen radius, closest first. Each restaurant page then picks the nearest open branch that delivers to you.</p>
    </td>
    <td valign="top">
      <img src="docs/screenshots/reviews.png" alt="Ratings and reviews drawer with star breakdown" width="300" />
      <p><b>Reviews with a rating breakdown</b><br/>Each restaurant shows its average, a five-to-one-star breakdown and recent reviews, with the owner's public reply underneath. Only customers whose order was delivered can review.</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/restaurant-menu.png" alt="KFC menu with a 25% off deal" width="300" />
      <p><b>Real menus, server-checked prices</b><br/>Menus with photos, searchable dishes, choice groups (portions, sides, extras) and running discounts. The cart and the final bill are always priced by the server.</p>
    </td>
    <td valign="top">
      <img src="docs/screenshots/checkout.png" alt="Checkout with the drop-off pin set from the current location" width="300" />
      <p><b>Drop-off pin from your location</b><br/>At checkout, one tap sets the delivery pin from the phone. The app confirms that the chosen branch delivers there, or suggests one that does.</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/promo-code.png" alt="Checkout order summary with promo code chips" width="300" />
      <p><b>Promo codes</b><br/>Usable codes appear as one-tap chips at checkout. Expiry, usage limits and minimum spend are all checked again when the order is placed.</p>
    </td>
    <td valign="top">
      <img src="docs/screenshots/rider-dashboard.png" alt="Rider's delivery card with location sharing and route map" width="300" />
      <p><b>Rider app with location sharing</b><br/>Riders go online, claim a job while it cooks and share their location. Pickup stays locked until the kitchen marks the food ready.</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/restaurant-dashboard.png" alt="Restaurant studio order row with a ready-in countdown" />
      <p><b>Kitchen that promises a time</b><br/>Owners accept an order by choosing how long it needs (10 to 45 minutes) and then cook against a live countdown. They can also reject an order, giving one of three reasons.</p>
    </td>
    <td valign="top">
      <img src="docs/screenshots/menu-builder.png" alt="Menu item editor with an option group" />
      <p><b>Menu builder</b><br/>Owners add categories and dishes, attach option groups such as "Dips" with priced options, and hide sold-out items with one tap.</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/admin-dashboard.png" alt="Admin live deliveries board" />
      <p><b>Admin live board</b><br/>Every delivery in progress on one map. A rider whose signal goes quiet is flagged.</p>
    </td>
    <td valign="top">
      <img src="docs/screenshots/owner-analytics.png" alt="Owner analytics dashboard" />
      <p><b>Analytics for owners and admins</b><br/>Revenue, top dishes, busiest hours, top restaurants and rider performance, for any date range.</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <img src="docs/screenshots/login.png" alt="Login screen asking which account type" />
      <p><b>A door for each role</b><br/>Customers, riders and restaurant owners pick their own sign-in. The server checks the account's real role, so the wrong door is refused.</p>
    </td>
    <td valign="top">
      <img src="docs/screenshots/cart.png" alt="Cart drawer with two KFC items" width="300" />
      <p><b>One bag per restaurant</b><br/>Customers can keep a bag open at several restaurants at once. Quantities change in place and the subtotal comes from the server.</p>
    </td>
  </tr>
</table>

<details>
<summary><b>More features</b></summary>

<br />

- **Role-based sign-in.** Customers, riders and restaurant owners each have their own login and sign-up screen; admins use a separate staff login.
- **Email and SMS verification** at sign-up, with codes stored only as HMAC hashes. Each channel can be switched off with `EMAIL_OTP_REQUIRED` / `PHONE_OTP_REQUIRED`.
- **Order timeline.** Every status change is recorded with its time.
- **Cancel before acceptance.** A cancelled order returns its promo-code use.
- **Rider ratings** go to the admin team only.
- **Saved addresses and favourite restaurants** on the customer's profile.
- **Support tickets.** Customers, riders and owners can open a ticket; admins reply and resolve it.
- **Account suspension** takes effect on the very next request.
- **Portion-quality reports.** Repeated "much less than expected" reports flag a dish.
- **Optional city directory** search through Google Places. It is off unless a server-side key is configured.

</details>

---

## Four roles

| Role | What they can do |
|---|---|
| **Customer** | Browse deals and restaurants, filter by cuisine and division, find restaurants near them, build a cart with options, check out with a promo code and a map pin, pay cash on delivery, track the rider live, cancel before acceptance, review the meal and the rider, manage addresses, favourites and support tickets |
| **Restaurant owner** | Create restaurants and branches, open or close a branch and set its map pin, build the menu (categories, dishes, option groups, availability), accept orders with a prep time or reject them with a reason, mark food ready, read analytics and reply to reviews |
| **Rider** | Go online or offline, set a vehicle, claim available deliveries, share live location, confirm pickup once food is ready, mark delivered and collect cash, see their delivery record |
| **Admin** | View every order, suspend or reactivate accounts, create and toggle promo codes, answer support tickets, read rider reviews, watch the live delivery board, read platform analytics |

> Admin accounts cannot be created by sign-up. They are created by `npm run seed:admin`.

---

## Tech stack

| Layer | Technology | Why we used it |
|---|---|---|
| Frontend | React 19 + Vite 8 | Fast component-based UI with instant development reloads |
| Styling | Tailwind CSS 3 | Consistent, responsive styling without leaving the markup |
| Routing | React Router 7 | Separate pages per role, with role-aware navigation |
| Maps | Leaflet + React Leaflet, OpenStreetMap tiles | Free maps for branch pins, "near me" and live tracking; no API key needed |
| Road routes | OSRM (public demo server) | Road-following route and duration for each delivery |
| HTTP client | Axios | One shared client that attaches the token and handles expired sessions |
| Backend | Node.js + Express 5 | A small, explicit REST API |
| Database | PostgreSQL 16 | Relational integrity, plus triggers, functions and procedures for business rules |
| DB driver | `pg` (no ORM) | Hand-written, parameterised SQL we can read and explain line by line |
| Auth | `jsonwebtoken` + `bcryptjs` | Custom JWT sessions with real logout, and salted password hashes |
| Email | Nodemailer (SMTP / Brevo), BulkSMSBD for SMS | Sign-up verification codes; a local "outbox" provider for development |
| Hosting | Vercel (frontend), Render (API), Neon (PostgreSQL) | Free tiers that fit a student project |

---

## Architecture

```mermaid
flowchart LR
    subgraph Browser["Browser (React + Vite)"]
        UI["Role-aware pages<br/>Customer · Owner · Rider · Admin"]
        MAP["Leaflet map<br/>OpenStreetMap tiles"]
        AX["Axios client<br/>adds JWT · handles 401"]
        UI --- MAP
        UI --> AX
    end

    subgraph API["Express API (Node.js)"]
        RL["Rate limiter<br/>(login · sign-up · OTP routes)"]
        AUTH["authenticateToken<br/>(protected routes)<br/>verify JWT + revoked/suspended check"]
        ROLE["requireRole(...)<br/>401 vs 403"]
        ROUTES["Route handlers<br/>ownership checks · BEGIN/COMMIT"]
        SVC["orderService<br/>maps DB errors to HTTP codes"]
        RL --> AUTH --> ROLE --> ROUTES --> SVC
    end

    subgraph DB["PostgreSQL"]
        TBL[("30 tables")]
        LOGIC["Functions · procedures<br/>triggers · view"]
        LOGIC --- TBL
    end

    AX -- "HTTPS / JSON" --> RL
    ROUTES -- "parameterised SQL ($1, $2…)" --> TBL
    SVC -- "SELECT place_order(...)" --> LOGIC
    ROUTES -. "road route (cached)" .-> OSRM["OSRM routing"]
    MAP -. "map tiles" .-> OSM["OpenStreetMap"]
```

How a request flows: the browser sends the JWT with every call. The API checks it against the database, then checks the caller's role, then confirms that the specific order, menu or delivery belongs to the caller. Only then does it run its SQL inside a transaction.

---

## Database design

<!-- TODO: add docs/screenshots/erd.png (exported ER diagram) and uncomment the line below. -->
<!-- <p align="center"><img src="docs/screenshots/erd.png" alt="Cravio ER diagram" width="900" /></p> -->

The core relationships, generated from the schema's foreign keys (the full schema has 30 tables):

```mermaid
erDiagram
    users ||--o{ restaurants : owns
    users ||--o{ orders : places
    users ||--o| rider_profiles : "rider has"
    users ||--o{ customer_addresses : saves
    users ||--o{ customer_favorites : likes
    restaurants ||--o{ restaurant_branches : has
    restaurants ||--o{ menu_categories : has
    menu_categories ||--o{ menu_items : contains
    menu_items ||--o{ modifier_groups : offers
    modifier_groups ||--o{ modifier_options : contains
    menu_items ||--o{ item_offers : "discounted by"
    users ||--o{ carts : fills
    carts ||--o{ cart_items : holds
    restaurant_branches ||--o{ orders : receives
    promo_codes |o--o{ orders : "applied to"
    orders ||--o{ order_items : contains
    orders ||--o{ payments : "paid by"
    orders ||--o| deliveries : "delivered by"
    orders ||--o{ order_events : "history of"
    orders ||--o| restaurant_reviews : "reviewed in"
    orders ||--o| rider_reviews : "rider rated in"
    users ||--o| rider_current_location : "rider is at"
    orders ||--o{ delivery_location_log : "trail of"
    users ||--o{ support_tickets : opens
```

### Triggers

| Trigger | Table | When it runs | Why it exists |
|---|---|---|---|
| `trg_sync_restaurant_rating` | `restaurant_reviews` → `restaurants` | After a review's rating is inserted, updated or deleted | Keeps `avg_rating` and `review_count` correct in the same transaction, so pages read a stored number instead of recalculating it |
| `trg_enforce_order_status_transition` | `orders` | Before a status change | Allows only valid moves (for example, `pending → confirmed → preparing`), however the update arrives |
| `trg_record_order_event` | `orders` → `order_events` | After an order is created or its status changes | Writes the order timeline automatically, including changes made by procedures |
| `trg_validate_order_branch_range` | `orders` | Before an order is inserted, or when its branch or drop-off pin changes | Guarantees the branch can take orders, is open, and delivers to that pin (error `CRV01` → HTTP 409) |
| `trg_log_rider_location` | `rider_current_location` → `delivery_location_log` | After a rider's position is saved | Records the trail of the order the rider is carrying |
| `trg_prevent_overlapping_item_offers` | `item_offers` | Before an offer is saved | Stops one dish having two discounts at the same time |

### Functions

| Function | Tables | Why it exists |
|---|---|---|
| `place_order(...)` | `carts`, `cart_items`, `menu_items`, `item_offers`, `promo_codes`, `orders`, `order_items`, `payments` | The whole checkout in one atomic call: validates customer, branch, cart, options and promo, prices everything from the database, and raises named errors (`CART_EMPTY`, `BRANCH_CLOSED`, `PROMO_CODE_EXPIRED`, …) |
| `restaurant_avg_rating(id)` | `restaurant_reviews`, `orders`, `restaurant_branches` | Computes a restaurant's average rating; used by the rating trigger |
| `distance_km(lat1, lng1, lat2, lng2)` | — | Haversine distance, so "nearest first" and ETAs are computed in SQL |
| `branches_by_distance(restaurant, lat, lng)` | `restaurant_branches` | A restaurant's branches sorted by distance, flagged open or closed and in or out of delivery range |
| `branch_is_open(opens, closes)` | — | Opening-hours check in Dhaka time, including hours that cross midnight |

Six more functions (`sync_restaurant_rating`, `enforce_order_status_transition`, `record_order_event`, `validate_order_branch_range`, `log_rider_location`, `prevent_overlapping_item_offers`) are the bodies of the triggers above.

### Stored procedures

| Procedure | Tables | Why it exists |
|---|---|---|
| `pickup_delivery(order, rider)` | `deliveries`, `orders`, `rider_profiles` | Locks the rows, checks that the delivery belongs to this rider, and refuses with `FOOD_NOT_READY` until the kitchen has marked the food ready |
| `complete_delivery(order, rider)` | `deliveries`, `orders`, `payments`, `rider_profiles` | Closes the delivery, marks the order delivered, settles cash on delivery and frees the rider, all in one step |

### View

| View | Why it exists |
|---|---|
| `active_item_offers` | Only offers running right now, with the discounted price already calculated. The home page, menu, cart and checkout all read offers through it. |

### Key complex queries

| Feature | What the query does |
|---|---|
| Popular right now (`GET /api/home/popular`) | Joins order items, orders, menu items and restaurants; counts the dishes ordered in the last 7 days; tops up the list with dishes from top-rated kitchens |
| Order again (`GET /api/home/order-again`) | Restaurants this customer ordered from, with order count and last order date |
| Restaurants near me (`GET /api/restaurants/nearby`) | Branches within a radius of the user, sorted by `distance_km()` |
| Rating breakdown (`GET /api/restaurants/:id/reviews/summary`) | Counts reviews per star level for one restaurant |
| Top restaurants (admin analytics) | Revenue, orders, customers and rating per restaurant over a date range |
| Rider performance (admin analytics) | Deliveries, average delivery time and ratings per rider |
| Most-ordered items (owner analytics) | Top dishes by quantity and revenue for one restaurant |
| Live delivery board (`GET /api/admin/deliveries/live`) | Every order on the road, with its rider's last position and how fresh the signal is |

### Transactions

Every multi-step write runs inside an explicit transaction: `BEGIN`, then `COMMIT`, or `ROLLBACK` if anything fails. Placing an order is the clearest case. The API opens a transaction and calls `place_order(...)`, which creates the order, its items and its payment row and empties the cart. If any check fails (an empty cart, a closed branch, an expired promo), the database raises an error, everything rolls back, and no half-made order can exist. Rows that two people might change at the same moment, such as two riders claiming one delivery, are locked with `SELECT … FOR UPDATE`.

---

## Security

| Concern | How Cravio handles it |
|---|---|
| **Passwords** | Hashed with bcrypt (salted, 10 rounds); never stored or logged in plain text |
| **Sessions** | Signed JWTs that last 7 days, each with a unique `jti`. Every request rechecks the token against the database. |
| **Real logout** | Logging out stores the token's `jti` in `revoked_tokens`, so that token stops working on the very next request |
| **Suspension** | A suspended account is refused on its next request, not just at its next login |
| **Roles** | Roles come from the database at login, never from the client. No or invalid session gets **401**; the wrong role gets **403**. |
| **Ownership** | Handlers check that an order, menu, branch or delivery belongs to the caller. Guessing another customer's order id returns 404. |
| **SQL injection** | Every value is passed as a parameter (`$1, $2, …`); no SQL is built from user input |
| **Brute force** | Login, sign-up and verification endpoints are rate-limited per IP |
| **Verification codes** | Stored only as HMAC hashes, with limited attempts and resends |

---

## API overview

All endpoints are under `/api`. "Public" means no login is needed; the other roles must be signed in.

<details open>
<summary><b>Auth and account</b></summary>

| Method | Path | Who | What it does |
|---|---|---|---|
| POST | `/auth/signup` | Public | Create a customer, rider or owner account |
| POST | `/auth/verify-otp` | Public | Confirm the email and SMS codes |
| POST | `/auth/login` | Public | Log in and receive a JWT |
| POST | `/auth/logout` | Signed in | Revoke the current token |
| GET / PATCH | `/account/profile` | Signed in | Read or update profile details |
| PATCH | `/account/password` | Signed in | Change password |
| GET / POST | `/account/addresses` | Customer | Saved delivery addresses |
| PUT / DELETE | `/account/favorites/:restaurantId` | Customer | Save or remove a favourite |

</details>

<details>
<summary><b>Browsing</b></summary>

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/home/banners`, `/home/deals`, `/home/popular`, `/home/top-restaurants` | Public | Home page carousel and rails |
| GET | `/home/order-again` | Customer | Restaurants this customer ordered from before |
| GET | `/restaurants` | Public | List with search, division, cuisine, open-now and sort filters |
| GET | `/restaurants/nearby` | Signed in | Branches near a location |
| GET | `/restaurants/:id` | Public | Restaurant details |
| GET | `/restaurants/:id/branches` | Signed in | Branches by distance from a pin |
| GET | `/restaurants/:id/reviews`, `/restaurants/:id/reviews/summary` | Signed in | Reviews and star breakdown |
| GET | `/menu/restaurants/:restaurantId` | Public | Full menu with options and running offers |

</details>

<details>
<summary><b>Cart and orders</b></summary>

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/cart/:restaurantId` | Customer | The cart for one restaurant |
| POST | `/cart/:restaurantId/items` | Customer | Add a dish (with options) |
| PATCH / DELETE | `/cart/items/:itemId` | Customer | Change quantity or remove |
| POST | `/orders` | Customer | Place an order (`place_order`) |
| GET | `/orders/my-orders` | Customer | Order history |
| GET | `/orders/:id` | Customer, owner, admin | Receipt and timeline (ownership-checked) |
| PATCH | `/orders/:id/cancel` | Customer | Cancel before acceptance |
| GET | `/orders/:id/tracking` | All roles involved | Rider position, distance and ETA |
| GET | `/orders/restaurant` | Owner | Incoming orders |
| POST | `/orders/:id/accept`, `/orders/:id/reject`, `/orders/:id/food-ready` | Owner, admin | Accept with a prep time, reject with a reason, mark food ready |
| POST | `/reviews/orders/:orderId`, `/reviews/orders/:orderId/rider` | Customer | Review the meal or the rider |

</details>

<details>
<summary><b>Rider</b></summary>

| Method | Path | Who | What it does |
|---|---|---|---|
| GET / PATCH | `/rider/profile` | Rider | Availability and vehicle |
| GET | `/rider/deliveries/available`, `/rider/deliveries/mine` | Rider | Jobs to claim, own deliveries |
| POST | `/rider/deliveries/:orderId/accept` | Rider | Claim a delivery (row-locked) |
| PATCH | `/rider/deliveries/:orderId/status` | Rider | Pickup (`pickup_delivery`) or delivered (`complete_delivery`) |
| PUT | `/rider/location` | Rider | Share current GPS position |

</details>

<details>
<summary><b>Restaurant owner</b></summary>

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/restaurants/mine` | Owner | Own restaurants and branches |
| POST | `/restaurants`, `/restaurants/:id/branches` | Owner, admin | Create a restaurant or branch |
| PATCH | `/restaurants/branches/:branchId/toggle`, `/restaurants/branches/:branchId/location` | Owner, admin | Open or close a branch, move its pin |
| POST | `/menu/restaurants/:restaurantId/categories`, `/menu/categories/:categoryId/items` | Owner, admin | Add a category or dish |
| PATCH | `/menu/items/:itemId`, `/menu/items/:itemId/toggle` | Owner, admin | Edit a dish, show or hide it |
| POST | `/menu/items/:itemId/modifier-groups`, `/menu/modifier-groups/:groupId/options` | Owner, admin | Option groups and options |
| GET | `/owner/analytics/:restaurantId/...` | Owner | Revenue, top items, busiest hours |
| GET / PUT | `/owner/reviews`, `/owner/reviews/:id/reply` | Owner | Read reviews and reply publicly |

</details>

<details>
<summary><b>Admin and support</b></summary>

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/admin/users` | Admin | List accounts by role |
| PATCH | `/admin/users/:id/status` | Admin | Suspend or reactivate |
| GET | `/admin/deliveries/live` | Admin | Live delivery board |
| GET | `/admin/rider-reviews` | Admin | Rider ratings and comments |
| GET | `/admin/analytics/...` | Admin | Trend, top restaurants, rider performance, user growth |
| GET | `/operations/promos` | Signed in | List promo codes |
| POST / PATCH | `/operations/promos`, `/operations/promos/:id` | Admin | Create and toggle promo codes |
| GET / POST | `/operations/tickets` | Signed in | Open and list support tickets |
| PATCH | `/operations/tickets/:id` | Admin | Reply, resolve or reopen |

</details>

Full reference: [docs/API.md](docs/API.md).

---

## Getting started

### Prerequisites

- **Node.js 22.12+** (tested with Node 26)
- **PostgreSQL 16+**
- npm (comes with Node.js)

### 1. Clone and install

```bash
git clone https://github.com/Shafi-8832/Cravio.git
cd Cravio
npm ci --prefix backend
npm ci --prefix frontend
```

### 2. Configure

```bash
npm run setup     # creates backend/.env and frontend/.env from the .env.example files,
                  # with freshly generated JWT and OTP secrets; never overwrites existing files
createdb cravio
```

Open `backend/.env` and set `DATABASE_URL` to your local database (for example `postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/cravio`), plus `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Every setting is described in [`backend/.env.example`](backend/.env.example).

For local development without real email or SMS, keep `EMAIL_PROVIDER=outbox` and `SMS_PROVIDER=outbox`. Verification codes are then printed in the API terminal. Alternatively, set `EMAIL_OTP_REQUIRED=false` and `PHONE_OTP_REQUIRED=false` to skip verification.

### 3. Create the database and load data

```bash
npm run db:migrate    # builds an empty DB, then applies checksummed migrations,
                      # functions, triggers, procedures and the view (safe to re-run)
npm run db:doctor     # checks the database is complete
npm run seed:admin    # creates the admin account from ADMIN_EMAIL / ADMIN_PASSWORD
npm run seed:real     # restaurant catalogue: 9 brands, branches in all 8 divisions, menus and photos
npm run seed:offers   # demo dish offers for the home page (re-run before a demo to refresh timers)
```

Optional fictional demo restaurants and test accounts: set `ALLOW_DEMO_SEED=true` and a `DEMO_PASSWORD` (8+ characters) in `backend/.env`, then run:

```bash
npm run seed:demo
```

### 4. Run

```bash
npm run dev:api       # API on http://localhost:8000  (health check: /api/health)
npm run dev:web       # in a second terminal: app on http://localhost:5173
```

Backend regression tests run against a separate, throwaway database. See [docs/SETUP.md](docs/SETUP.md) for that, deployment notes and troubleshooting.

> **Never** run `backend/db/schema.sql` by hand on an existing database: it resets tables. `npm run db:migrate` is the safe path.

---

## Demo accounts

These are created by the seed scripts on **your local database**. No passwords are stored in the repository: each account uses the password you set in `backend/.env`.

| Role | Email | Password | Created by |
|---|---|---|---|
| Customer | `ayesha@example.com` | your `DEMO_PASSWORD` | `npm run seed:demo` |
| Restaurant owner | `nabila@example.com` | your `DEMO_PASSWORD` | `npm run seed:demo` |
| Rider | `jahangir@example.com` | your `DEMO_PASSWORD` | `npm run seed:demo` |
| Restaurant owner (KFC) | `owner.kfc@cravio.test` | your `BRAND_OWNER_PASSWORD` (or `DEMO_PASSWORD`) | `npm run seed:real` |
| Admin | your `ADMIN_EMAIL` | your `ADMIN_PASSWORD` | `npm run seed:admin` (use **Staff log in**) |

---

## Project structure

```text
Cravio/
├── backend/
│   ├── server.js            # Express app: CORS, rate limits, route mounting
│   ├── middleware/          # authenticateToken (JWT + revocation), requireRole
│   ├── routes/              # one file per area: auth, restaurants, menu, cart, orders, rider, admin…
│   ├── services/            # orderService (checkout), OTP, email/SMS providers, OSRM routing
│   ├── db/
│   │   ├── schema.sql       # base schema (used only on an empty database)
│   │   ├── migrations/      # 001–013 additive, checksummed migrations
│   │   ├── functions/       # functions, procedures, triggers and the view
│   │   └── seeds/           # demo item offers
│   ├── scripts/             # migrate, doctor, seed scripts, catalogue importers
│   ├── data/                # restaurant catalogue snapshots and local images
│   └── tests/               # backend regression suites
├── frontend/
│   └── src/
│       ├── pages/           # one page per screen (home, restaurant, checkout, dashboards…)
│       ├── components/      # cards, cart, map, intro animation, profile sections
│       ├── context/         # auth, cart and location state
│       ├── services/        # API calls per area, all through one Axios client
│       └── utils/           # API client, formatting, order lifecycle helpers
├── docs/                    # setup, API, database, feature walkthroughs, screenshots
├── scripts/                 # setup, backend test runner, handoff packager
└── package.json             # root scripts (db:migrate, seed:*, dev:api, dev:web…)
```

---

## Team and acknowledgments

<table>
  <tr>
    <td align="center" width="50%">
      <b>Atik Khan</b><br />
      <a href="https://github.com/atikdevx">GitHub</a>
    </td>
    <td align="center" width="50%">
      <a href="https://github.com/Shafi-8832"><img src="https://github.com/Shafi-8832.png" width="80" alt="" style="border-radius:50%" /></a><br />
      <b>Ahnaf Ahmed Safi</b><br />
      <a href="https://github.com/Shafi-8832">@Shafi-8832</a>
    </td>
  </tr>
</table>

Built for **CSE 216: Database Sessional**, Department of Computer Science and Engineering, **Bangladesh University of Engineering and Technology (BUET)**.

**Thanks to:**

- [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and [Leaflet](https://leafletjs.com) for the maps.
- [Project OSRM](https://project-osrm.org) for road routing.
- The restaurant brands whose public menus appear in the catalogue snapshot. Cravio is a coursework project with no affiliation with them, and no order reaches a real restaurant. Photo sources and credits are in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

Released under the [MIT License](LICENSE).

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F59E0B,100:EA580C&height=90&section=footer" width="100%" alt="" />
