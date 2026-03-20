// src/middleware/auth.js
const jwt    = require('jsonwebtoken');
const { query } = require('../../config/database');
const R      = require('../utils/response');
const logger = require('../utils/logger');

// Verify JWT and attach { staffId, businessId, role } to req.user
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return R.error(res, 'Authentication required', 401);
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Confirm staff still exists and is active
    const { rows } = await query(
      `SELECT s.id, s.business_id, s.role, s.is_active, b.plan_status
       FROM staff s
       JOIN businesses b ON b.id = s.business_id
       WHERE s.id = $1`,
      [payload.staffId]
    );

    if (!rows.length || !rows[0].is_active) {
      return R.error(res, 'Account not found or deactivated', 401);
    }

    req.user = {
      staffId:    rows[0].id,
      businessId: rows[0].business_id,
      role:       rows[0].role,
      planStatus: rows[0].plan_status,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return R.error(res, 'Token expired', 401);
    if (err.name === 'JsonWebTokenError')  return R.error(res, 'Invalid token', 401);
    logger.error('Auth middleware error', { error: err.message });
    return R.error(res, 'Authentication error', 500);
  }
}

// Role guard — pass allowed roles: authorize('owner', 'manager')
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return R.forbidden(res, 'Insufficient permissions for this action');
    }
    next();
  };
}

// Business isolation — ensure URL param :businessId matches req.user.businessId
function ownBusiness(req, res, next) {
  const paramId = req.params.businessId;
  if (paramId && paramId !== req.user.businessId) {
    return R.forbidden(res, 'Access denied to this business');
  }
  next();
}

module.exports = { authenticate, authorize, ownBusiness };
