// Which contact details a new account must prove before it can be used.
//
// Two switches, both ON unless set to the exact string 'false':
//   EMAIL_OTP_REQUIRED  — send and require an email code
//   PHONE_OTP_REQUIRED  — send and require an SMS code
// They exist for deployments that do not yet have an email or SMS provider
// account. A switched-off channel sends nothing; its verified_at column stays
// NULL. With both off, a new account can log in straight after signup.
//
// Default is ON, so forgetting a variable can only make the rule stricter,
// never looser.

function emailOtpRequired() {
  return process.env.EMAIL_OTP_REQUIRED !== 'false'
}

function phoneOtpRequired() {
  return process.env.PHONE_OTP_REQUIRED !== 'false'
}

// The channels that must be verified: ['email', 'phone'], ['email'],
// ['phone'] or [] (no verification at all).
function requiredChannels() {
  const channels = []
  if (emailOtpRequired()) channels.push('email')
  if (phoneOtpRequired()) channels.push('phone')
  return channels
}

// True when every required channel has a verified_at timestamp (and so
// always true when no channel is required). Used by login, the auth
// middleware and the verify endpoint, so all three apply the same rule.
function isAccountVerified(user) {
  return requiredChannels().every(channel => user[`${channel}_verified_at`] !== null)
}

module.exports = { emailOtpRequired, phoneOtpRequired, requiredChannels, isAccountVerified }
