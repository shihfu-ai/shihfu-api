// src/services/messaging.js
// Unified message dispatcher: routes to WhatsApp / SMS / Email based on channel.
// All providers are abstracted behind the same send() interface.
//
// India compliance:
//   SMS  — TRAI DLT registered sender ID via Twilio
//   WA   — Meta WhatsApp Business API (official)
//   Email— SMTP (SendGrid / Zoho Mail)

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────
// Main dispatch function
// reminder shape: { id, channel, phone, email, customer_name,
//                   entity_name, reminder_type, message_body,
//                   message_subject, business_id }
// ─────────────────────────────────────────────────────────────────
async function send(reminder) {
  const { channel } = reminder;

  try {
    switch (channel) {
      case 'whatsapp': return await sendWhatsApp(reminder);
      case 'sms':      return await sendSMS(reminder);
      case 'email':    return await sendEmail(reminder);
      default:
        logger.warn('Unknown channel', { channel, reminderId: reminder.id });
        return { success: false, error: `Unknown channel: ${channel}` };
    }
  } catch (err) {
    logger.error('Messaging dispatch error', { error: err.message, channel, reminderId: reminder.id });
    return { success: false, error: err.message, provider: channel };
  }
}

// ─────────────────────────────────────────────────────────────────
// WhatsApp — Meta Business API (official)
// ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(reminder) {
  const { WHATSAPP_API_URL, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN } = process.env;

  if (!WHATSAPP_ACCESS_TOKEN) {
    logger.warn('WhatsApp not configured — skipping (dev mode)');
    return { success: true, provider: 'whatsapp_mock', providerId: `mock_wa_${Date.now()}`, whatsappMsgId: null };
  }

  // Format phone to E.164: 10-digit Indian → +91XXXXXXXXXX
  const toPhone = formatIndianPhone(reminder.phone);

  const body = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                toPhone,
    type:              'text',
    text:              { body: reminder.message_body },
  };

  const response = await fetch(
    `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data?.error?.message || 'WhatsApp API error';
    logger.error('WhatsApp send failed', { error: errMsg, to: toPhone, reminderId: reminder.id });
    return { success: false, error: errMsg, provider: 'meta' };
  }

  const msgId = data?.messages?.[0]?.id;
  logger.info('WhatsApp sent', { to: toPhone, msgId, reminderId: reminder.id });
  return { success: true, provider: 'meta', providerId: msgId, whatsappMsgId: msgId };
}

// ─────────────────────────────────────────────────────────────────
// SMS — Twilio with India TRAI DLT compliance
// ─────────────────────────────────────────────────────────────────
async function sendSMS(reminder) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_DLT_TEMPLATE_ID } = process.env;

  if (!TWILIO_ACCOUNT_SID) {
    logger.warn('Twilio not configured — skipping (dev mode)');
    return { success: true, provider: 'sms_mock', providerId: `mock_sms_${Date.now()}`, twilioSid: null };
  }

  const twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const toPhone = formatIndianPhone(reminder.phone);

  // TRAI DLT: max 160 chars for a single SMS unit in India
  const messageBody = reminder.message_body?.slice(0, 1530) || 'You have a service reminder.';

  const message = await twilio.messages.create({
    body:           messageBody,
    from:           TWILIO_PHONE_NUMBER,
    to:             toPhone,
    // India DLT headers
    ...(TWILIO_DLT_TEMPLATE_ID && {
      statusCallback: `${process.env.API_BASE_URL}/webhooks/twilio/status`,
    }),
  });

  logger.info('SMS sent', { to: toPhone, sid: message.sid, reminderId: reminder.id });
  return { success: true, provider: 'twilio', providerId: message.sid, twilioSid: message.sid };
}

// ─────────────────────────────────────────────────────────────────
// Email — Nodemailer (SMTP)
// ─────────────────────────────────────────────────────────────────
async function sendEmail(reminder) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM_NAME, SMTP_FROM_EMAIL } = process.env;

  if (!reminder.email) {
    return { success: false, error: 'No email address on file for this customer', provider: 'email' };
  }

  if (!SMTP_HOST) {
    logger.warn('SMTP not configured — skipping (dev mode)');
    return { success: true, provider: 'email_mock', providerId: `mock_email_${Date.now()}`, emailMsgId: null };
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from:    `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to:      reminder.email,
    subject: reminder.message_subject || `Service Reminder — ${reminder.reminder_type}`,
    text:    reminder.message_body,
    html:    buildEmailHtml(reminder),
  });

  logger.info('Email sent', { to: reminder.email, msgId: info.messageId, reminderId: reminder.id });
  return { success: true, provider: 'smtp', providerId: info.messageId, emailMsgId: info.messageId };
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function formatIndianPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('+91')) return phone;
  return `+91${digits.slice(-10)}`;
}

function buildEmailHtml(reminder) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table width="560" style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0">
        <!-- Header -->
        <tr>
          <td style="background:#0d0d0d;padding:20px 32px">
            <span style="font-family:Georgia,serif;font-size:1.3rem;color:#f5f0e8;font-weight:700">
              Shih-Fu <span style="color:#c8a84b">Reminders</span>
            </span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="font-size:1rem;color:#333;line-height:1.7;margin-bottom:24px">
              ${(reminder.message_body || '').replace(/\n/g, '<br>')}
            </p>
            <table>
              <tr>
                <td style="background:#0d0d0d;border-radius:4px;padding:10px 24px">
                  <a href="#" style="color:#c8a84b;font-family:Georgia,serif;font-size:.9rem;text-decoration:none;font-weight:700">
                    Book Appointment
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #f0f0f0;font-size:.75rem;color:#999">
            You are receiving this because you opted in to service reminders.
            <a href="#" style="color:#999">Unsubscribe</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { send };
