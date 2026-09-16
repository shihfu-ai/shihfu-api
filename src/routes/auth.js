// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query, withTransaction } = require('../../config/database');
const { validate, schemas } = require('../middleware/validate');
const { authenticate }      = require('../middleware/auth');
const messagingService      = require('../services/messaging');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();

// ─── POST /auth/register ──────────────────────────────────────────
// Creates a business + owner staff account in one transaction
router.post('/register', validate(schemas.register), async (req, res) => {
  const {
    businessName, ownerName, phone, email, password,
    city, state, gstin, vertical, preferredLang,
  } = req.body;

  try {
    const result = await withTransaction(async (client) => {
      // Check email uniqueness
      const exists = await client.query(
        'SELECT id FROM businesses WHERE email = $1', [email]
      );
      if (exists.rows.length) {
        throw { statusCode: 409, message: 'A business with this email already exists' };
      }

      // Create business
      const { rows: [business] } = await client.query(`
        INSERT INTO businesses
          (name, owner_name, phone, email, city, state, gstin, vertical,
           preferred_language, plan, plan_status, max_customers,
           trial_ends_at, onboarded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'trialing','trialing',500,
                NOW() + INTERVAL '30 days', NOW())
        RETURNING id, name, vertical, plan, plan_status, trial_ends_at
      `, [businessName, ownerName, phone, email, city, state, gstin, vertical, preferredLang]);

      // Hash password and create owner staff
      const passwordHash = await bcrypt.hash(password, 12);
      const { rows: [staff] } = await client.query(`
        INSERT INTO staff (business_id, name, email, password_hash, role)
        VALUES ($1,$2,$3,$4,'owner')
        RETURNING id, name, email, role
      `, [business.id, ownerName, email, passwordHash]);

      return { business, staff };
    });

    // Issue tokens
    const { accessToken, refreshToken } = issueTokens(result.staff.id);

    logger.info('New business registered', { businessId: result.business.id, email });

    return R.created(res, {
      accessToken,
      refreshToken,
      business: result.business,
      staff: {
        id:           result.staff.id,
        name:         result.staff.name,
        email:        result.staff.email,
        role:         result.staff.role,
        // Same shape as /auth/login's staff object — without this the
        // dashboard shows generic placeholders ("Your Business") right
        // after signup until the next login repopulates it.
        businessId:   result.business.id,
        businessName: result.business.name,
        vertical:     result.business.vertical,
        plan:         result.business.plan,
        planStatus:   result.business.plan_status,
        language:     preferredLang,
      },
    }, 'Business registered successfully');

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    logger.error('Register error', { error: err.message });
    return R.error(res, 'Registration failed');
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────
router.post('/login', validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;

  try {
    const { rows } = await query(`
      SELECT s.id, s.name, s.email, s.password_hash, s.role, s.is_active,
             b.id AS business_id, b.name AS business_name, b.vertical,
             b.plan, b.plan_status, b.preferred_language
      FROM staff s
      JOIN businesses b ON b.id = s.business_id
      WHERE s.email = $1
    `, [email]);

    if (!rows.length) return R.error(res, 'Invalid email or password', 401);

    const staff = rows[0];
    if (!staff.is_active) return R.error(res, 'Account is deactivated', 403);

    const valid = await bcrypt.compare(password, staff.password_hash);
    if (!valid) return R.error(res, 'Invalid email or password', 401);

    // Update last login
    await query('UPDATE staff SET last_login_at = NOW() WHERE id = $1', [staff.id]);

    const { accessToken, refreshToken } = issueTokens(staff.id);

    return R.success(res, {
      accessToken,
      refreshToken,
      staff: {
        id:           staff.id,
        name:         staff.name,
        email:        staff.email,
        role:         staff.role,
        businessId:   staff.business_id,
        businessName: staff.business_name,
        vertical:     staff.vertical,
        plan:         staff.plan,
        planStatus:   staff.plan_status,
        language:     staff.preferred_language,
      },
    }, 'Login successful');

  } catch (err) {
    logger.error('Login error', { error: err.message });
    return R.error(res, 'Login failed');
  }
});

// ─── POST /auth/refresh ───────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return R.badRequest(res, 'Refresh token required');

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_SECRET + '_refresh');
    const { accessToken, refreshToken: newRefresh } = issueTokens(payload.staffId);
    return R.success(res, { accessToken, refreshToken: newRefresh });
  } catch {
    return R.error(res, 'Invalid or expired refresh token', 401);
  }
});

// ─── POST /auth/forgot-password ───────────────────────────────────
// Always responds with the same generic message regardless of
// whether the email exists, to avoid leaking which emails have
// accounts. A real OTP is only generated and emailed when it does.
router.post('/forgot-password', validate(schemas.forgotPassword), async (req, res) => {
  const { email } = req.body;
  const genericMessage = 'If an account exists for that email, we have sent a password reset code to it.';

  try {
    const { rows } = await query(
      `SELECT s.id, s.name, s.email FROM staff s WHERE s.email = $1 AND s.is_active = true LIMIT 1`,
      [email]
    );

    if (rows.length) {
      const staff = rows[0];
      const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
      const otpHash = await bcrypt.hash(otp, 10);

      await query(`
        INSERT INTO password_reset_otps (staff_id, otp_hash, expires_at)
        VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
      `, [staff.id, otpHash]);

      await messagingService.sendOtpEmail({ email: staff.email, otp, ownerName: staff.name });
      logger.info('Password reset OTP generated', { staffId: staff.id });
    }

    return R.success(res, {}, genericMessage);
  } catch (err) {
    logger.error('Forgot password error', { error: err.message });
    // Still return the generic message — don't leak whether the lookup itself failed
    return R.success(res, {}, genericMessage);
  }
});

// ─── POST /auth/reset-password ─────────────────────────────────────
router.post('/reset-password', validate(schemas.resetPassword), async (req, res) => {
  const { email, otp, newPassword } = req.body;

  try {
    const { rows: staffRows } = await query(
      `SELECT id FROM staff WHERE email = $1 AND is_active = true LIMIT 1`, [email]
    );
    if (!staffRows.length) return R.error(res, 'Invalid or expired code', 400);
    const staffId = staffRows[0].id;

    const { rows: otpRows } = await query(`
      SELECT id, otp_hash, expires_at, attempt_count FROM password_reset_otps
      WHERE staff_id = $1 AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `, [staffId]);

    if (!otpRows.length) return R.error(res, 'Invalid or expired code', 400);
    const record = otpRows[0];

    if (record.attempt_count >= 5) return R.error(res, 'Too many attempts — request a new code', 429);
    if (new Date(record.expires_at) < new Date()) return R.error(res, 'Invalid or expired code', 400);

    const valid = await bcrypt.compare(otp, record.otp_hash);
    if (!valid) {
      await query(`UPDATE password_reset_otps SET attempt_count = attempt_count + 1 WHERE id = $1`, [record.id]);
      return R.error(res, 'Invalid or expired code', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await withTransaction(async (client) => {
      await client.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [passwordHash, staffId]);
      await client.query(`UPDATE password_reset_otps SET used_at = NOW() WHERE id = $1`, [record.id]);
    });

    logger.info('Password reset completed', { staffId });
    return R.success(res, {}, 'Password updated — you can now sign in with your new password');
  } catch (err) {
    logger.error('Reset password error', { error: err.message });
    return R.error(res, 'Failed to reset password');
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT s.id, s.name, s.email, s.role, s.last_login_at,
             b.id AS business_id, b.name AS business_name, b.vertical,
             b.plan, b.plan_status, b.trial_ends_at, b.city, b.preferred_language
      FROM staff s JOIN businesses b ON b.id = s.business_id
      WHERE s.id = $1
    `, [req.user.staffId]);

    return R.success(res, rows[0]);
  } catch (err) {
    logger.error('Me endpoint error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────
router.post('/logout', authenticate, (req, res) => {
  // Stateless JWT — client deletes token. Add token blacklist here if needed.
  return R.success(res, {}, 'Logged out successfully');
});

// ─── Helpers ──────────────────────────────────────────────────────
function issueTokens(staffId) {
  const accessToken = jwt.sign(
    { staffId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  const refreshToken = jwt.sign(
    { staffId },
    process.env.JWT_SECRET + '_refresh',
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
  return { accessToken, refreshToken };
}

module.exports = router;
