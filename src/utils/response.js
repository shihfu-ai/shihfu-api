// src/utils/response.js
// Standardised JSON response helpers used across all route handlers

const success = (res, data = {}, message = 'Success', statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });

const created = (res, data = {}, message = 'Created') =>
  success(res, data, message, 201);

const paginated = (res, rows, total, page, limit, message = 'Success') =>
  res.status(200).json({
    success: true,
    message,
    data: rows,
    pagination: {
      total,
      page:       parseInt(page),
      limit:      parseInt(limit),
      totalPages: Math.ceil(total / limit),
    },
  });

const error = (res, message = 'Internal server error', statusCode = 500, errors = null) =>
  res.status(statusCode).json({
    success: false,
    message,
    ...(errors && { errors }),
  });

const notFound  = (res, message = 'Resource not found')  => error(res, message, 404);
const forbidden = (res, message = 'Forbidden')            => error(res, message, 403);
const badRequest= (res, message = 'Bad request', errs)   => error(res, message, 400, errs);
const conflict  = (res, message = 'Conflict')             => error(res, message, 409);

module.exports = { success, created, paginated, error, notFound, forbidden, badRequest, conflict };
