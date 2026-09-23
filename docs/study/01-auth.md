# 01 — Auth (register / login / logout / "me")

## Files involved

**Frontend**
- `frontend/src/pages/LoginPage.jsx` — picks which login screen to show from the URL slug; `/login` with no slug shows the role chooser.
- `frontend/src/pages/SignupPage.jsx` — same fork for signup.
- `frontend/src/components/RoleChooser.jsx` — the three cards (customer / rider / owner) plus the cardless staff link.
- `frontend/src/components/AuthForm.jsx` — the one form both screens use; builds the request and redirects on success.
- `frontend/src/utils/roles.js` — the copy, colours and **role key** each screen is scoped to.
- `frontend/src/services/authApi.js` — the three axios wrappers (`signIn`, `signUp`, `signOut`).
- `frontend/src/utils/api.js` — the shared axios instance; request interceptor attaches the token, response interceptor clears the session on a 401.
- `frontend/src/context/AuthContext.jsx` — holds the user in React state and mirrors it into `localStorage`.

**Route**
- `backend/routes/auth.js` — all three endpoints. The commented-out old copy that used to sit below `module.exports` has been deleted (Task A); the file is now 580 lines of live code only.

**Controller**
- None. Auth queries `pool` directly; only orders has a service layer.

**Middleware**
- `backend/middleware/auth.js` — `authenticateToken`, used by logout (`auth.js:530`) and by every other authenticated route in the app.
- `backend/middleware/rateLimit.js` — in-memory attempt counter, applied to login and signup at `server.js:52-53`.

**SQL**
- `backend/db/schema.sql:52-86` — `users` (`role` has a 4-value CHECK at `:67-75`).
- `backend/db/schema.sql:94-127` — `rider_profiles`.
- `backend/db/schema.sql:805-817` — `revoked_tokens` (`jti` is UNIQUE at `:814`).

---

## Flow

### Register

1. Visitor clicks a card on `/signup`; `RoleChooser.jsx` links to `/signup/customer|rider|owner` (`RoleChooser.jsx:29`).
2. `SignupPage.jsx:9` turns the slug into a role object via `roleFromSlug` (`utils/roles.js:83`). An unknown slug falls back to the chooser rather than 404-ing.
3. `AuthForm.jsx:42-43` sends `{ name, email, password, phone, role: role.key }` to `POST /api/auth/signup`.
4. `server.js:53` runs the rate limiter first — more than 30 attempts from one IP in 15 minutes → **429**.
5. `auth.js:60-99` validates shape: all five fields present and non-blank, name ≤ 100, phone matches `/^[0-9+\-\s()]{7,20}$/`, email matches a basic pattern, password 8-72 bytes. Any failure → **400**.
6. **`auth.js:105-109` rejects `role === 'admin'` outright with 403.** This is a separate, explicit refusal rather than being folded into "invalid role".
7. `auth.js:112-116` checks the role against `SIGNUP_ROLES` (`auth.js:32-36`) → **400** if it is not one of the three.
8. `auth.js:122` re-reads the role **out of the server's own array**, not out of the request body. Same characters, but the value bound into the INSERT is one this file approved.
9. `auth.js:128` takes a dedicated connection, `:137` opens the transaction.
10. `:140-143` checks the email is free → **409** (with `ROLLBACK`) if taken.
11. `:157` hashes the password with bcrypt, cost 10.
12. `:160-190` inserts the user; `:196-218` inserts a `rider_profiles` row **only if** the new role is `rider`. That second write is why this needs a transaction.
13. `:223` commits. `:231` generates a random 16-byte `jti`; `:234-249` signs a 7-day JWT carrying `id`, `email`, `role`, `jti`.
14. **201** with `{ token, user }`. `AuthForm.jsx:46` stores both and `:49` redirects by the role the **server** returned.

### Login

1. `AuthForm.jsx:44` sends `{ email, password, expectedRole: role.key }`.
2. `auth.js:312-320` validates shape → **400**.
3. `auth.js:329-337` validates `expectedRole` against `DB_ROLES` (`auth.js:22-26`) → **400** for anything else. Omitting it entirely is legal and skips the check.
4. `auth.js:351-359` looks the user up by lower-cased email. No row → **401**, deliberately vague.
5. `auth.js:379-386` compares the password against the stored bcrypt hash. Mismatch → the **same** 401 text, so a stranger cannot tell the two apart.
6. `auth.js:404` reads `const actualRole = user.role` — **the role that counts, straight off the database row**.
7. `auth.js:412-418` compares `expectedRole` with `actualRole` → **403** naming the mismatch. **This runs after the password check on purpose** (comment at `:407-411`): checking earlier would let anyone learn which role an email belongs to without knowing the password.
8. `auth.js:425-433` rejects a suspended account → **403**.
9. `auth.js:454-472` signs the token with `role: actualRole` — never the client's value.
10. `auth.js:476-489` strips `password` off the row and returns **200** `{ token, user }`.

### Logout

1. `AuthContext.jsx:25-31` calls `signOut()` **and awaits it before clearing storage**, so a failed revocation stays visible instead of being falsely reported.
2. `auth.js:530` runs `authenticateToken`, which puts the token's `jti` and `exp` on `req.user`.
3. `auth.js:541-545` inserts that `jti` into `revoked_tokens` and opportunistically deletes expired rows in the same statement.
4. **200**. Every later request carrying that token dies at `middleware/auth.js:40`.

### "me"

**NOT FOUND** — there is no `GET /api/auth/me`. Two routes do that job instead: `GET /api/account/profile` (`account.js:13`, any role) and `GET /api/profile` (`profile.js:275`, role-branching). On a page refresh the frontend does **not** call either: `AuthContext.jsx:5-8` rehydrates the user straight from `localStorage`.

---

## The SQL

**1. Email uniqueness pre-check** — `auth.js:141`
```sql
SELECT id FROM users WHERE email=$1
```
Returns the id of any existing account with that email, or no rows. `$1` = the trimmed, lower-cased email. Used to answer 409 with a clear message; the real guarantee is the UNIQUE constraint (see Transactions).

**2. Create the account** — `auth.js:163-180`
```sql
INSERT INTO users
(
  name,
  email,
  password,
  role,
  phone
)

VALUES
($1,$2,$3,$4,$5)

RETURNING
id,
name,
email,
role
```
Inserts the user and hands the stored row straight back, so the token is built from what was actually saved rather than from what was requested. `$1` name, `$2` email, `$3` bcrypt hash, **`$4` = `roleToCreate` from the server-side allowlist (`auth.js:141`)**, `$5` phone.

**3. Rider profile companion row** — `auth.js:201-210`
```sql
INSERT INTO rider_profiles
(
  user_id,
  vehicle_type,
  status
)

VALUES
($1,$2,$3)
```
Gives a new rider an empty profile so later rider routes have a row to update. `$1` = the id returned by query 2, `$2` = `null` (vehicle chosen later), `$3` = `'offline'`.

**4. Fetch the account at login** — `auth.js:353`
```sql
SELECT * FROM users WHERE email=$1
```
Returns the whole user row, including the bcrypt hash needed for comparison and the `role` that becomes the token's role. `$1` = trimmed lower-cased email.

**5. Revoke the token at logout** — `auth.js:541-545`
```sql
WITH cleanup AS (DELETE FROM revoked_tokens WHERE expires_at < CURRENT_TIMESTAMP)
INSERT INTO revoked_tokens (jti, user_id, expires_at)
VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (jti) DO NOTHING
```
One statement doing two jobs: the CTE sweeps rows whose tokens have expired anyway (they are already rejected by signature expiry, so the row is redundant), and the INSERT records this `jti`. `ON CONFLICT DO NOTHING` makes double-logout harmless. `$1` = `req.user.jti`, `$2` = `req.user.id`, `$3` = the token's `exp` as a Unix timestamp.

**6. The session check every authenticated request runs** — `middleware/auth.js:27-28`
```sql
SELECT u.id, u.email, u.role, u.is_active, rt.id AS revoked_id
FROM users u LEFT JOIN revoked_tokens rt ON rt.jti=$1 WHERE u.id=$2
```
Returns the live user row plus a flag for whether this particular token was revoked. **The LEFT JOIN is what makes one round trip answer two questions** — the user row comes back regardless of whether a matching revocation exists, and `revoked_id` is non-null only when it does. `$1` = `jti`, `$2` = user id.

---

## Transactions

**Signup — YES.** `auth.js:128` `pool.connect()`, `:137` `BEGIN`, `:223` `COMMIT`, `ROLLBACK` at `:148` (email taken) and `:264` (any error), `client.release()` in `finally` at `:284`. Inside the transaction: the uniqueness `SELECT` (`:121`), the `users` INSERT (`:141`), and conditionally the `rider_profiles` INSERT (`:179`). **This is the justification for the transaction** — a rider whose user row committed but whose profile row failed would be a half-created account that every rider route then breaks on.

The `SELECT`-then-`INSERT` pair is still a race between two concurrent signups. It is closed not by the transaction but by the UNIQUE constraint on `users.email` (`schema.sql:58-60`) plus the `23505` catch at `auth.js:272`, which converts the constraint violation into the same 409.

**Login — NO, and correctly so.** It runs one `SELECT` and writes nothing.

**Logout — NO `BEGIN`, and correctly so.** `auth.js:541-545` is a single statement. A statement in PostgreSQL is atomic on its own, so the DELETE and the INSERT either both happen or neither does.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Successful login (`auth.js:483`); successful logout (`:549`). |
| **201** | Account created (`auth.js:252`). |
| **400** | Signup: missing/blank field, over-length name or email, bad phone pattern, bad email, password outside 8-72 bytes (`:61, :73, :87, :96`), or a role not in `SIGNUP_ROLES` (`:113`). Login: missing/mistyped email or password (`:313`), or an `expectedRole` outside the four DB roles (`:330`). Also `server.js:96` for malformed JSON. |
| **401** | Login: no such email (`:364`) or wrong password (`:392`) — **identical message for both**. Logout: any `authenticateToken` failure (`middleware/auth.js:8, 16, 21, 40`). |
| **403** | Signup with `role: 'admin'` (`:106`). Login where `expectedRole` disagrees with the DB role (`:414`), or the account is suspended (`:427`). |
| **409** | Signup email already registered — both the pre-check (`:150`) and the constraint catch (`:253`). |
| **413** | Body over 100 kB (`server.js:97`). |
| **429** | Rate limit exceeded on login or signup (`rateLimit.js:21`). |
| **500** | Unexpected error in signup (`:274`), login (`:505`), logout (`:567`). |

---

## Graded requirements touched

| Requirement | How this slice satisfies it |
|---|---|
| **Custom auth** | Fully in-house. `bcryptjs` hashing at cost 10 (`auth.js:157`) — bcrypt generates a per-user salt and stores it inside the hash string, so no separate salt column is needed. `jsonwebtoken` signing at `:215` and `:435`. No third-party auth service anywhere. |
| **Role resolved server-side** | `auth.js:404` reads the role off the `users` row; `:461` puts *that* value in the token. The client's `expectedRole` can only ever cause a rejection (`:393`) — it never sets anything. Signup binds `roleToCreate` from the server's own array (`:110`). |
| **Logout genuinely invalidates** | `revoked_tokens` + the join at `middleware/auth.js:27-28`. The token is dead on the very next request, not at next login. This is the difference between real revocation and a frontend redirect. |
| **Explicit transaction** | Signup, `auth.js:137/223/264`. |
| **Role authorization** | `authenticateToken` on logout; the 403 paths at `:106` and `:414`. Full treatment in unit 02. |
| **Parameterised SQL** | All six queries use `$n`. No concatenation. |
| Trigger / function / procedure | None in this slice. |
| Complex query | None — the closest is the LEFT JOIN at `middleware/auth.js:27-28`, which is a two-table join but not an aggregate. |

---

## Likely viva questions

**1. Where does the role in the token come from, and why does that matter?**
From the database row: `auth.js:404` reads `user.role` off the row fetched at `:334`, and `:461` signs that into the token. If we trusted a role from the request body, anyone could POST `"role":"admin"` and become an administrator. The client's `expectedRole` exists only to be *rejected against* (`:393`); it never widens access and never sets the session role.

**2. Why is the role-mismatch check after the password check, not before?**
Comment at `auth.js:407-411`. If it ran first, someone could type any email with a junk password: a 403 would mean "that email is a rider", a 401 would mean "it is not". Without knowing a single password they could map every account on the platform — that is **user enumeration**. Verifying the password first means a stranger always gets the same flat 401.

**3. Why do you need a transaction for signup when it is "just creating a user"?**
Because it is not one write. A rider signup inserts into `users` **and** `rider_profiles` (`auth.js:141` and `:179`). Without `BEGIN`/`COMMIT`, a failure between them leaves a rider account with no profile row, and every rider route then breaks on a missing row. The transaction makes both or neither.

**4. Why store a `jti` in the token instead of just deleting it client-side? (design justification — why not X)**
Because deleting a token in the browser is not revocation — the token is still validly signed and works from curl. So each token carries a random id, `jti` (`auth.js:231`), and logout writes that id to `revoked_tokens` (`:518`). The alternative designs were: **short expiry only**, which leaves a stolen token live until it expires; or **server-side sessions**, which means a session store lookup on every request and loses the stateless-token benefit. The chosen middle ground costs one join — not one extra query, because it is folded into the user lookup the request needed anyway (`middleware/auth.js:27-28`) — and buys instant revocation. The same join also catches suspension (`is_active`), so both take effect on the next request.

**5. Someone steals a valid token. What still protects the account, and what does not?**
Protects: logout kills it immediately (`revoked_tokens`); an admin suspending the account kills it immediately (`is_active`, `middleware/auth.js:42`); it expires after 7 days (`:246`, `:469`). Does not protect: nothing binds the token to a device or IP, and changing the password does **not** revoke outstanding tokens — `account.js:35-76` updates the hash but never writes to `revoked_tokens`. That is listed as a defect below.

---

## Gaps and defects

**DML statements with no surrounding BEGIN/COMMIT (complete list for this slice)**
- `auth.js:541-545` — logout's revoke. **Not a defect.** One statement, atomic by itself.
- That is the only one. Signup's two inserts are both inside the transaction.

**Ownership checks bypassable by changing an id in the URL or body**
- None in this slice. No auth route takes a user id from the caller — signup creates a new row, login looks up by email, logout uses `req.user.jti` from the verified token.
- Worth stating plainly in the viva: **there is no `/api/auth/users/:id`-shaped route here to attack.**

**SQL built by string concatenation instead of `$n`**
- None. All six queries are parameterised.

**Real defects**

1. **Signup checks `JWT_SECRET` after `COMMIT`.** `auth.js:223` commits, then `:226-228` throws if the secret is missing. The throw lands in the catch at `:264`, which calls `ROLLBACK` on an already-committed transaction — that does nothing but log a warning. Result: the account exists but the caller gets a 500 and no token. Unreachable in practice because `server.js:9-12` exits at boot if the secret is missing, so it is dead code with a latent ordering bug. The check belongs before `BEGIN`.

2. **Changing your password does not revoke existing tokens.** `account.js:35-76` rewrites the hash but writes nothing to `revoked_tokens`, and its own success message admits it: *"Your other devices stay signed in until their session expires"* (`account.js:70`). If you change your password *because* you think someone has your session, you have not locked them out. The fix would be a `DELETE`/insert sweep of that user's outstanding `jti`s, which the current schema cannot do — `revoked_tokens` records only revoked ids, so there is no list of *live* ones to revoke.

3. **Login returns the entire `users` row minus the password.** `auth.js:476-479` spreads the row, so `is_active`, `created_at` and `phone` all go to the browser. Nothing here is dangerous, but it is a wider surface than the endpoint needs, and it is the row that then gets written into `localStorage`.

4. **The rate limiter is in-memory and per-process.** `rateLimit.js:1-2` says so itself. It also keys on `req.ip` (`:12`) while `app.set('trust proxy')` is **NOT FOUND** in `server.js` — behind a reverse proxy every request would carry the proxy's IP, so all users would share one bucket. Fine for local development, wrong for a deployment.

5. **The frontend trusts `localStorage` for session restore.** `AuthContext.jsx:5-8` rehydrates the user object from storage with no server call. A user can edit their stored role and the UI will draw the admin navigation for them. **Not a security hole** — every protected endpoint re-reads the role from the database (`middleware/auth.js:27-28`) — but an examiner may point at it, and the honest answer is "display only, the server never trusts it."

6. **`auth.js` is 868 lines, of which 560-868 are a commented-out old copy of the whole file.** Not a security issue; it is a hazard when reading line numbers under exam pressure, and it makes the live code look longer than it is.

7. **Password rules are weak.** `auth.js:95` enforces only a length of 8-72 bytes. No check against common passwords, no complexity requirement. Defensible, but say it deliberately rather than being caught by it.

---

## Explain-it-in-60-seconds

So auth is completely custom — no Firebase, no Auth0. On signup we validate everything server-side, and the important bit is the role: we explicitly refuse `admin` with a 403, then we check the requested role against an allowlist in the file, and we insert the copy from *our* array, not the string the browser sent. Because a rider signup writes to two tables — `users` and `rider_profiles` — the whole thing is wrapped in BEGIN/COMMIT, so you can't end up with half an account. Password goes through bcrypt at cost 10, which salts per user automatically.

On login, we look the user up by email, compare the password with bcrypt, and only *then* check whether the role card they clicked matches their real role — and the order there is deliberate. If we checked the role first, you could type anyone's email with a junk password and tell from the 403 whether they're a rider or a customer. That's user enumeration, so we make both failures return the identical 401. The role we put in the token is read off the database row; the role the client sends can only ever cause a rejection, never set anything.

The token carries a random id called a `jti`, and logout writes that id into a `revoked_tokens` table. So every authenticated request does one query that joins `users` to `revoked_tokens` — one round trip that answers both "who are you" and "has this token been killed", and it also catches suspended accounts. That's what makes logout real revocation instead of just a frontend redirect. The one thing I'd flag honestly: changing your password doesn't revoke your other sessions yet.
