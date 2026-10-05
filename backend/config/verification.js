// Which contact details a new account must prove before it can be used.
//
// Email is always required. Phone is required unless PHONE_OTP_REQUIRED is
// set to 'false' — a switch for deployments that do not yet have an SMS
// gateway account. With phone OTP off, the phone number is still saved, but
// it stays unverified (users.phone_verified_at = NULL) and no SMS is sent.
//
// Default is ON, so forgetting the variable can only make the rule
// stricter, never looser.

function phoneOtpRequired() {
  return process.env.PHONE_OTP_REQUIRED !== 'false'
}

// The channels that must be verified, e.g. ['email', 'phone'] or ['email'].
function requiredChannels() {
  return phoneOtpRequired() ? ['email', 'phone'] : ['email']
}

// True when every required channel has a verified_at timestamp. Used by
// login, the auth middleware and the verify endpoint, so all three apply
// exactly the same rule.
function isAccountVerified(user) {
  return requiredChannels().every(channel => user[`${channel}_verified_at`] !== null)
}

module.exports = { phoneOtpRequired, requiredChannels, isAccountVerified }
