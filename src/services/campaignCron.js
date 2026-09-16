// src/services/campaignCron.js
// Dispatches bulk campaigns (festival/promo blasts) to a business's
// whole customer base — either inline from POST /campaigns when
// scheduled for "now", or picked up here on a timer when scheduled
// for a future date.

const cron     = require('node-cron');
const { query, withTransaction } = require('../../config/database');
const messagingService = require('./messaging');
const logger   = require('../utils/logger');

function startCampaignCron() {
  const schedule = process.env.CAMPAIGN_CRON_SCHEDULE || '*/15 * * * *'; // every 15 min
  logger.info(`Campaign cron scheduled: ${schedule}`);

  cron.schedule(schedule, async () => {
    logger.info('Campaign cron: starting run');
    try {
      const { rows: due } = await query(`
        SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC LIMIT 20
      `);
      if (!due.length) { logger.info('Campaign cron: no due campaigns'); return; }

      for (const campaign of due) {
        try { await dispatchCampaign(campaign); }
        catch (err) { logger.error('Campaign dispatch error', { campaignId: campaign.id, error: err.message }); }
      }
    } catch (err) {
      logger.error('Campaign cron: unhandled error', { error: err.message });
    }
  });
}

// Sends one campaign to every eligible customer of its business and
// records the outcome. A customer is eligible if their own preferred
// channel is one of the campaign's selected channels AND they're
// opted in for it — mirrors the consent check individual reminders
// already use, so a blast never reaches someone who never agreed to
// be messaged on that channel.
async function dispatchCampaign(campaign) {
  await query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [campaign.id]);

  const { rows: customers } = await query(`
    SELECT id, name, phone, email, preferred_channel,
           opted_in_whatsapp, opted_in_sms, opted_in_email
    FROM customers
    WHERE business_id = $1 AND status != 'opted_out'
  `, [campaign.business_id]);

  let sent = 0, skipped = 0, failed = 0;

  for (const customer of customers) {
    const channel = customer.preferred_channel;
    const optIn = {
      whatsapp: customer.opted_in_whatsapp,
      sms:      customer.opted_in_sms,
      email:    customer.opted_in_email,
    };

    if (!campaign.channels.includes(channel) || !optIn[channel]) { skipped++; continue; }

    const result = await messagingService.send({
      id: campaign.id, channel,
      phone: customer.phone, email: customer.email,
      customer_name: customer.name,
      message_body: campaign.message_body,
      message_subject: campaign.label,
    });

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO message_log
          (business_id, customer_id, campaign_id, channel, recipient,
           message_body, provider, provider_msg_id, status, consent_verified)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
      `, [
        campaign.business_id, customer.id, campaign.id, channel,
        channel === 'email' ? customer.email : customer.phone,
        campaign.message_body, result.provider, result.providerId,
        result.success ? 'sent' : 'failed',
      ]);
    });

    result.success ? sent++ : failed++;
  }

  await query(`
    UPDATE campaigns
    SET status = 'sent', sent_count = $1, skipped_count = $2, failed_count = $3, sent_at = NOW()
    WHERE id = $4
  `, [sent, skipped, failed, campaign.id]);

  logger.info('Campaign dispatched', { campaignId: campaign.id, sent, skipped, failed });
  return { sent, skipped, failed };
}

module.exports = { startCampaignCron, dispatchCampaign };
