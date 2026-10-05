-- ============================================================
-- 013 — ACCOUNT VERIFICATION: email + phone one-time passwords (OTP)
--
-- A new signup must prove it owns the email address and the phone number
-- it typed before it can use Cravio. This migration adds the storage:
--
--   * users.email_verified_at / users.phone_verified_at
--       When each contact was proven. NULL = not yet. An account is
--       "verified" only when BOTH are set. These are timestamps rather
--       than booleans because "when" is useful for support and costs
--       nothing extra.
--
--   * otp_verifications
--       One row per code we sent. The code itself is NEVER stored — only
--       an HMAC-SHA256 hash of it (see services/otpService.js). Temporary
--       codes live here instead of on users so that resends, attempt
--       counts and history never clutter the account row.
--
-- The rules that USE this storage (5-minute expiry, 5 attempts, resend
-- cooldown) live in backend/services/otpService.js. No trigger/function
-- is added: the logic is plain request-time checks.
--
-- Applied by `npm run db:migrate`. Idempotent.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The verification timestamps on users.
--
-- No DEFAULT on purpose: a new row is unverified unless the code that
-- inserts it says otherwise ("fail closed"). Seed scripts and the admin
-- seeder set both columns explicitly because those accounts are created
-- by the dev team, not by an untrusted visitor.
-- ------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMP;


-- Every account that existed before this migration was created before
-- verification existed, so it is treated as verified. Without this, every
-- current user would be locked out the moment the migration ran.
-- (On a brand-new database the table is empty and this updates nothing.)
UPDATE users
SET email_verified_at = COALESCE(email_verified_at, created_at, CURRENT_TIMESTAMP),
    phone_verified_at = COALESCE(phone_verified_at, created_at, CURRENT_TIMESTAMP)
WHERE email_verified_at IS NULL
   OR phone_verified_at IS NULL;


-- ------------------------------------------------------------
-- 2. The OTP table.
--
-- status lifecycle:
--   pending    → the live code for this user + channel
--   verified   → used successfully (can never be used again)
--   superseded → replaced by a newer code after a resend
--   locked     → too many wrong guesses; only a resend gives a new code
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otp_verifications (

    id SERIAL PRIMARY KEY,

    -- ON DELETE CASCADE: codes mean nothing without their account.
    user_id INTEGER NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    channel VARCHAR(10) NOT NULL
        CHECK (channel IN ('email', 'phone')),

    -- 64 hex characters = a SHA-256 sized HMAC. Never the code itself.
    otp_hash CHAR(64) NOT NULL,

    expires_at TIMESTAMP NOT NULL,

    status VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'superseded', 'locked')),

    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    verified_at TIMESTAMP
);


-- At most ONE live code per user per channel. A partial unique index only
-- covers rows WHERE status = 'pending', so old verified/superseded rows can
-- pile up as history without breaking the rule.
CREATE UNIQUE INDEX IF NOT EXISTS uq_otp_one_pending_per_channel
    ON otp_verifications(user_id, channel)
    WHERE status = 'pending';


-- Resend cooldown and the hourly cap both ask "this user's newest codes on
-- this channel", which this index answers without scanning the table.
CREATE INDEX IF NOT EXISTS idx_otp_user_channel_created
    ON otp_verifications(user_id, channel, created_at DESC);
