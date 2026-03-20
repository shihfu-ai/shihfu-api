// src/services/reminderCron.js
// Scheduled job — processes due reminders every hour.
// Uses node-cron. Called once at server startup.

const cron     = require('node-cron');
const { query } = require('../../config/database');
const messagingService = require('./messaging');
const logger   = require('../utils/logger');

const BATCH_SIZE       = 100;   // reminders per cron run
const MAX_ATTEMPTS     = 3;     // retry limit before marking as failed
const RETRY_DELAY_MINS = 60;    // wait between retries

function startReminderCron() {
  const schedule = process.env.REMINDER_CRON_SCHEDULE || '0 * * * *'; // every hour
  logger.info(`Reminder cron scheduled: ${schedule}`);

  cron.schedule(schedule, async () => {
    logger.info('Reminder cron: starting run');
    try {
      await processduedReminders();
    } catch (err) {
      logger.error('Reminder cron: unhandled error', { error: err.message });
    }
  });
}

async function processduedReminders() {
  // Fetch all due (overdue + today) reminders that haven't hit retry limit
  const { rows: due } = await query(`
    SELECT
      r.id, r.business_id, r.customer_id, r.entity_id, r.reminder_type,
      r.channel, r.scheduled_at, r.message_body, r.message_subject,
      r.attempt_count,
      c.name AS customer_name, c.phone, c.email,
      e.name AS entity_name
    FROM reminders r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN customer_entities e ON e.id = r.entity_id
    WHERE r.status = 'scheduled'
      AND r.scheduled_at <= NOW()
      AND r.attempt_count < $1
      AND c.status != 'opted_out'
    ORDER BY r.scheduled_at ASC
    LIMIT $2
  `, [MAX_ATTEMPTS, BATCH_SIZE]);

  if (!due.length) {
    logger.info('Reminder cron: no due reminders');
    return;
  }

  logger.info(`Reminder cron: processing ${due.length} reminders`);
  let sent = 0, failed = 0;

  for (const reminder of due) {
    try {
      // Check opted-in status for channel
      const { rows: [customer] } = await query(
        'SELECT opted_in_whatsapp, opted_in_sms, opted_in_email FROM customers WHERE id = $1',
        [reminder.customer_id]
      );

      const channelOptIn = {
        whatsapp: customer?.opted_in_whatsapp,
        sms:      customer?.opted_in_sms,
        email:    customer?.opted_in_email,
      };

      if (!channelOptIn[reminder.channel]) {
        // Mark skipped — no consent for this channel
        await query(`
          UPDATE reminders SET status = 'skipped', failure_reason = 'No consent for channel'
          WHERE id = $1
        `, [reminder.id]);
        logger.warn('Skipped reminder — no consent', { reminderId: reminder.id, channel: reminder.channel });
        continue;
      }

      // Dispatch message
      const result = await messagingService.send(reminder);

      if (result.success) {
        await query(`
          UPDATE reminders
          SET status = 'sent', sent_at = NOW(),
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW(),
              twilio_sid = $1, whatsapp_msg_id = $2, email_msg_id = $3
          WHERE id = $4
        `, [result.twilioSid || null, result.whatsappMsgId || null, result.emailMsgId || null, reminder.id]);

        // Append to message_log
        await query(`
          INSERT INTO message_log
            (business_id, customer_id, reminder_id, channel, recipient,
             message_body, provider, provider_msg_id, status, consent_verified)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sent',true)
        `, [
          reminder.business_id, reminder.customer_id, reminder.id,
          reminder.channel,
          reminder.channel === 'email' ? reminder.email : reminder.phone,
          reminder.message_body, result.provider, result.providerId,
        ]);

        sent++;
      } else {
        // Failed — increment attempt, maybe mark as failed if max reached
        const newAttempts = reminder.attempt_count + 1;
        const newStatus   = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'scheduled';
        const nextRetry   = newStatus === 'scheduled'
          ? new Date(Date.now() + RETRY_DELAY_MINS * 60 * 1000)
          : null;

        await query(`
          UPDATE reminders
          SET status = $1, attempt_count = $2, last_attempt_at = NOW(),
              failure_reason = $3,
              scheduled_at = COALESCE($4, scheduled_at)
          WHERE id = $5
        `, [newStatus, newAttempts, result.error, nextRetry, reminder.id]);

        failed++;
        logger.warn('Reminder send failed', {
          reminderId: reminder.id, channel: reminder.channel,
          attempt: newAttempts, error: result.error,
        });
      }
    } catch (err) {
      logger.error('Error processing reminder', { reminderId: reminder.id, error: err.message });
      failed++;
    }
  }

  logger.info(`Reminder cron complete: ${sent} sent, ${failed} failed out of ${due.length}`);
}

module.exports = { startReminderCron, processduedReminders };
