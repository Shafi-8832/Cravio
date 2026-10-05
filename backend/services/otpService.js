// ============================================================
// OTP SERVICE — email + phone verification codes
//
// The rules live here; routes/auth.js only turns the results into HTTP.
//
//   * A code is 6 random digits from crypto.randomInt (a cryptographically
//     secure generator — Math.random() is predictable and must not be used).
//   * Only an HMAC-SHA256 hash of the code is stored. HMAC = a hash mixed
//     with a server-side secret key (OTP_HMAC_SECRET). There are only one
//     million 6-digit codes, so a plain hash (or even bcrypt) could be
//     reversed by trying them all; without the secret key that is impossible.
//   * A code expires after 5 minutes, works once, and allows 5 guesses.
//   * A new code can be requested once per minute, at most 5 per hour.
//
// The plaintext code exists only in memory, long enough to send it. It is
// never logged, never stored, and never returned in an API response.
// ============================================================

const crypto = require('crypto')
const pool = require('../db/pool')
const { sendEmail, sendSms } = require('./notify')
const { requiredChannels } = require('../config/verification')

const OTP_TTL_MINUTES = 5
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_SECONDS = 60
const MAX_SENDS_PER_HOUR = 5

// Fixed SQL per channel. The column name cannot be a $1 parameter in
// PostgreSQL, so instead of building the string we pick one of two
// complete, hand-written queries.
const MARK_USER_VERIFIED_SQL = {
  email: 'UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = $1',
  phone: 'UPDATE users SET phone_verified_at = CURRENT_TIMESTAMP WHERE id = $1'
}


function generateOtp() {
  // randomInt's upper bound is exclusive: 0..999999, zero-padded to 6 digits.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}


// The user id and channel are mixed into the hash, so a hash copied from
// one row (or one channel) is useless for any other row.
function hashOtp(userId, channel, otp) {
  return crypto
    .createHmac('sha256', process.env.OTP_HMAC_SECRET)
    .update(`${userId}:${channel}:${otp}`)
    .digest('hex')
}


// Constant-time comparison: a normal === stops at the first different
// character, and that tiny timing difference can leak how much matched.
function hashesMatch(storedHash, candidateHash) {
  const a = Buffer.from(storedHash, 'hex')
  const b = Buffer.from(candidateHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}


// 01712345678 → 017*****678, so the UI can say where the SMS went without
// echoing the full number back.
function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '*****' + phone.slice(-3) : null
}


// ------------------------------------------------------------
// Creates a fresh code for one channel. Must run inside the caller's
// transaction (it takes a client, not the pool).
//
// The previous pending code is retired first, because the partial unique
// index allows only one 'pending' row per user + channel.
// Returns the plaintext code so the caller can send it AFTER commit.
// ------------------------------------------------------------
async function createOtp(client, userId, channel) {
  await client.query(
    `UPDATE otp_verifications
     SET status = 'superseded'
     WHERE user_id = $1 AND channel = $2 AND status = 'pending'`,
    [userId, channel]
  )

  const otp = generateOtp()

  // Expiry is computed by the database clock, the same clock every later
  // "has it expired?" check uses — app-server and DB clocks can drift.
  await client.query(
    `INSERT INTO otp_verifications (user_id, channel, otp_hash, expires_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP + make_interval(mins => $4))`,
    [userId, channel, hashOtp(userId, channel, otp), OTP_TTL_MINUTES]
  )

  return otp
}


// ------------------------------------------------------------
// Sends the codes. Called only after COMMIT: an email cannot be "rolled
// back", so we never send a code for a row that might not exist.
// A failed send is reported, not thrown — the account exists and the
// visitor can press "resend". The error is logged WITHOUT the code.
// ------------------------------------------------------------
async function deliverOtps(user, codes) {
  const delivery = {}

  if (codes.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: 'Your Cravio email verification code',
        text: `Your Cravio email verification code is ${codes.email}. It expires in ${OTP_TTL_MINUTES} minutes. If you did not sign up for Cravio, ignore this email.`
      })
      delivery.email = 'sent'
    } catch (error) {
      console.error('OTP email delivery failed for user', user.id, '-', error.message)
      delivery.email = 'failed'
    }
  }

  if (codes.phone) {
    try {
      await sendSms({
        to: user.phone,
        text: `Cravio phone verification code: ${codes.phone}. Valid for ${OTP_TTL_MINUTES} minutes. Do not share it.`
      })
      delivery.phone = 'sent'
    } catch (error) {
      console.error('OTP SMS delivery failed for user', user.id, '-', error.message)
      delivery.phone = 'failed'
    }
  }

  return delivery
}


// ------------------------------------------------------------
// Checks one submitted code. Runs inside the caller's transaction.
//
// Returns { status } where status is one of:
//   'verified' | 'invalid' (+ attemptsLeft) | 'expired' | 'locked'
// ------------------------------------------------------------
async function checkOtp(client, userId, channel, submittedOtp) {
  // FOR UPDATE locks the row until COMMIT. Without it, ten parallel
  // requests could all read attempt_count = 0 and get ten free guesses.
  const result = await client.query(
    `SELECT id, otp_hash, attempt_count,
            expires_at <= CURRENT_TIMESTAMP AS is_expired
     FROM otp_verifications
     WHERE user_id = $1 AND channel = $2 AND status = 'pending'
     FOR UPDATE`,
    [userId, channel]
  )

  const row = result.rows[0]

  if (!row) {
    // No live code. Tell "you guessed too often" apart from "this code is
    // gone/used" by looking at the newest row for this channel.
    const latest = await client.query(
      `SELECT status FROM otp_verifications
       WHERE user_id = $1 AND channel = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [userId, channel]
    )
    return { status: latest.rows[0]?.status === 'locked' ? 'locked' : 'expired' }
  }

  // An expired code is not counted as an attempt: nothing was guessed.
  if (row.is_expired) return { status: 'expired' }

  const attempts = row.attempt_count + 1

  if (hashesMatch(row.otp_hash, hashOtp(userId, channel, submittedOtp))) {
    // status leaves 'pending', so this same code can never match again.
    await client.query(
      `UPDATE otp_verifications
       SET status = 'verified', verified_at = CURRENT_TIMESTAMP, attempt_count = $2
       WHERE id = $1`,
      [row.id, attempts]
    )
    await client.query(MARK_USER_VERIFIED_SQL[channel], [userId])
    return { status: 'verified' }
  }

  // Wrong guess. On the last allowed attempt the code is locked for good;
  // only a resend (with its own cooldown) produces a new one.
  const locked = attempts >= MAX_ATTEMPTS
  await client.query(
    `UPDATE otp_verifications
     SET attempt_count = $2, status = $3
     WHERE id = $1`,
    [row.id, attempts, locked ? 'locked' : 'pending']
  )

  return locked ? { status: 'locked' } : { status: 'invalid', attemptsLeft: MAX_ATTEMPTS - attempts }
}


// ------------------------------------------------------------
// POST /api/auth/verify-otp
// codes = { email: '123456' | undefined, phone: '654321' | undefined }
//
// Returns null if the email is not a known account (the route answers that
// with the same message as a wrong code). Otherwise:
//   { results: { email: {...}, phone: {...} }, emailVerified, phoneVerified,
//     accountVerified }
// where each result status is 'verified' | 'already_verified' | 'invalid'
// | 'expired' | 'locked'.
// ------------------------------------------------------------
async function verifyAccount(email, codes) {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const userResult = await client.query(
      `SELECT id, email_verified_at, phone_verified_at
       FROM users
       WHERE email = $1
       FOR UPDATE`,
      [email]
    )

    const user = userResult.rows[0]

    if (!user) {
      await client.query('ROLLBACK')
      return null
    }

    const alreadyVerified = {
      email: user.email_verified_at !== null,
      phone: user.phone_verified_at !== null
    }

    const results = {}

    // Only required channels are checked. With phone OTP switched off
    // (config/verification.js), a submitted phone code is simply ignored.
    for (const channel of requiredChannels()) {
      if (!codes[channel]) continue

      // An already-verified channel is not checked again — there is no
      // live code for it, and the account is not harmed by a late submit.
      results[channel] = alreadyVerified[channel]
        ? { status: 'already_verified' }
        : await checkOtp(client, user.id, channel, codes[channel])
    }

    // COMMIT even when a code was wrong: the increased attempt_count must
    // be saved, otherwise the attempt limit would never be reached.
    await client.query('COMMIT')

    const verified = {
      email: alreadyVerified.email || results.email?.status === 'verified',
      phone: alreadyVerified.phone || results.phone?.status === 'verified'
    }

    return {
      results,
      emailVerified: verified.email,
      phoneVerified: verified.phone,
      accountVerified: requiredChannels().every(channel => verified[channel])
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}


// ------------------------------------------------------------
// POST /api/auth/resend-otp
// requested = ['email'] | ['phone'] | ['email', 'phone']
//
// Returns one of:
//   { outcome: 'nothing_to_send' }   unknown email or already verified
//   { outcome: 'cooldown', retryAfter }
//   { outcome: 'limit' }
//   { outcome: 'sent', delivery, phoneMasked }
// ------------------------------------------------------------
async function resendOtps(email, requested) {
  const client = await pool.connect()
  let user
  const codes = {}

  try {
    await client.query('BEGIN')

    // Locking the user row makes two simultaneous resend clicks run one
    // after the other, so both cannot slip past the cooldown check.
    const userResult = await client.query(
      `SELECT id, email, phone, email_verified_at, phone_verified_at
       FROM users
       WHERE email = $1
       FOR UPDATE`,
      [email]
    )

    user = userResult.rows[0]

    // Only required channels that still need verifying get a new code.
    const channels = user
      ? requested.filter(channel =>
          requiredChannels().includes(channel) && user[`${channel}_verified_at`] === null)
      : []

    if (channels.length === 0) {
      await client.query('ROLLBACK')
      return { outcome: 'nothing_to_send' }
    }

    // Check every channel BEFORE sending any, so a "both" request is all
    // or nothing rather than half-sent.
    let retryAfter = 0
    let overLimit = false

    for (const channel of channels) {
      // One aggregate query answers both rate-limit questions:
      // how long since the newest code, and how many in the last hour.
      const stats = await client.query(
        `SELECT
           EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(created_at)))::int AS seconds_since_last,
           COUNT(*) FILTER (WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour')::int AS sent_last_hour
         FROM otp_verifications
         WHERE user_id = $1 AND channel = $2`,
        [user.id, channel]
      )

      const { seconds_since_last: secondsSinceLast, sent_last_hour: sentLastHour } = stats.rows[0]

      if (secondsSinceLast !== null && secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
        retryAfter = Math.max(retryAfter, RESEND_COOLDOWN_SECONDS - secondsSinceLast)
      }
      if (sentLastHour >= MAX_SENDS_PER_HOUR) overLimit = true
    }

    if (overLimit) {
      await client.query('ROLLBACK')
      return { outcome: 'limit' }
    }

    if (retryAfter > 0) {
      await client.query('ROLLBACK')
      return { outcome: 'cooldown', retryAfter }
    }

    for (const channel of channels) {
      codes[channel] = await createOtp(client, user.id, channel)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  const delivery = await deliverOtps(user, codes)
  return { outcome: 'sent', delivery, phoneMasked: maskPhone(user.phone) }
}


module.exports = {
  OTP_TTL_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  createOtp,
  deliverOtps,
  verifyAccount,
  resendOtps,
  maskPhone
}
