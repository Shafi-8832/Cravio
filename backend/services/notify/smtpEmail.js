// Email over SMTP. SMTP is the common language every email provider speaks
// (Brevo, Resend, Amazon SES, Gmail with an app password, ...), so switching
// provider is a .env change, not a code change.
const nodemailer = require('nodemailer')

const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']

let transporter = null

function missingConfig() {
  return REQUIRED.filter(name => !process.env[name])
}

function getTransporter() {
  // Created once and reused: it keeps the SMTP connection settings.
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT)
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // Port 465 uses TLS from the first byte; 587 upgrades with STARTTLS.
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  }
  return transporter
}

async function send({ to, subject, text }) {
  await getTransporter().sendMail({ from: process.env.EMAIL_FROM, to, subject, text })
}

module.exports = { name: 'smtp', missingConfig, send }
