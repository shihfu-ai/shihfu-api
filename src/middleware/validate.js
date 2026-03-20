// src/middleware/validate.js
const Joi = require('joi');
const R   = require('../utils/response');

// Generic validator factory — pass a Joi schema, validate req.body
const validate = (schema, source = 'body') => (req, res, next) => {
  const { error, value } = schema.validate(req[source], {
    abortEarly:     false,
    stripUnknown:   true,
    allowUnknown:   false,
  });

  if (error) {
    const errors = error.details.map(d => ({
      field:   d.path.join('.'),
      message: d.message.replace(/"/g, ''),
    }));
    return R.badRequest(res, 'Validation failed', errors);
  }

  req[source] = value;
  next();
};

// ─── Reusable field definitions ───────────────────────────────────
const indianPhone = Joi.string()
  .pattern(/^[6-9]\d{9}$/)
  .messages({ 'string.pattern.base': 'Must be a valid 10-digit Indian mobile number' });

const channels = ['whatsapp', 'sms', 'email'];
const verticals = ['veterinary', 'salon_beauty', 'auto_repair', 'home_services', 'retail', 'other'];
const languages = ['en', 'hi', 'ta', 'te', 'kn', 'ml', 'mr', 'gu', 'bn', 'pa'];

// ─── Schemas ──────────────────────────────────────────────────────
const schemas = {

  // Auth
  register: Joi.object({
    businessName:   Joi.string().min(2).max(120).required(),
    ownerName:      Joi.string().min(2).max(100).required(),
    phone:          indianPhone.required(),
    email:          Joi.string().email().required(),
    password:       Joi.string().min(8).max(72).required(),
    city:           Joi.string().max(60),
    state:          Joi.string().max(60),
    gstin:          Joi.string().length(15).uppercase(),
    vertical:       Joi.string().valid(...verticals).required(),
    preferredLang:  Joi.string().valid(...languages).default('en'),
  }),

  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  // Customers
  createCustomer: Joi.object({
    name:             Joi.string().min(2).max(120).required(),
    phone:            indianPhone.required(),
    email:            Joi.string().email().allow('', null),
    city:             Joi.string().max(60).allow('', null),
    state:            Joi.string().max(60).allow('', null),
    pincode:          Joi.string().pattern(/^\d{6}$/).allow('', null),
    preferredChannel: Joi.string().valid(...channels).default('whatsapp'),
    optedInSms:       Joi.boolean().default(false),
    optedInWhatsapp:  Joi.boolean().default(false),
    optedInEmail:     Joi.boolean().default(false),
    tags:             Joi.array().items(Joi.string().max(30)).max(10),
    notes:            Joi.string().max(1000).allow('', null),
    source:           Joi.string().valid('manual', 'import', 'qr', 'pos', 'web').default('manual'),
    externalId:       Joi.string().max(100).allow('', null),
    // Pet / entity
    entity: Joi.object({
      name:          Joi.string().max(100),
      entityType:    Joi.string().valid('dog','cat','bird','rabbit','other_animal','car','two_wheeler','commercial_vehicle','person','other'),
      breedOrModel:  Joi.string().max(120),
      dobOrYear:     Joi.string().max(20),
      gender:        Joi.string().valid('male','female','unknown').allow('', null),
      registrationNo: Joi.string().max(20).allow('', null),
      insuranceExpiry: Joi.date().allow(null),
      notes:         Joi.string().max(500).allow('', null),
    }),
  }),

  updateCustomer: Joi.object({
    name:             Joi.string().min(2).max(120),
    email:            Joi.string().email().allow('', null),
    city:             Joi.string().max(60).allow('', null),
    state:            Joi.string().max(60).allow('', null),
    pincode:          Joi.string().pattern(/^\d{6}$/).allow('', null),
    preferredChannel: Joi.string().valid(...channels),
    optedInSms:       Joi.boolean(),
    optedInWhatsapp:  Joi.boolean(),
    optedInEmail:     Joi.boolean(),
    tags:             Joi.array().items(Joi.string().max(30)).max(10),
    notes:            Joi.string().max(1000).allow('', null),
    status:           Joi.string().valid('active','dormant','lost','opted_out'),
  }),

  // Service events
  createServiceEvent: Joi.object({
    customerId:      Joi.string().uuid().required(),
    entityId:        Joi.string().uuid().allow(null),
    serviceType:     Joi.string().min(2).max(100).required(),
    serviceCategory: Joi.string().max(60).allow('', null),
    eventDate:       Joi.date().max('now').default(() => new Date()),
    eventTime:       Joi.string().pattern(/^\d{2}:\d{2}$/).allow(null),
    status:          Joi.string().valid('scheduled','completed','cancelled','no_show').default('completed'),
    amountCharged:   Joi.number().min(0).max(999999).allow(null),
    amountPaid:      Joi.number().min(0).max(999999).allow(null),
    paymentMethod:   Joi.string().valid('upi','cash','card','emi','other').allow(null),
    followUpDays:    Joi.number().integer().min(1).max(730).allow(null),
    staffName:       Joi.string().max(100).allow('', null),
    diagnosis:       Joi.string().max(2000).allow('', null),
    prescription:    Joi.string().max(2000).allow('', null),
    notes:           Joi.string().max(2000).allow('', null),
  }),

  // Reminders
  createReminder: Joi.object({
    customerId:    Joi.string().uuid().required(),
    entityId:      Joi.string().uuid().allow(null),
    serviceEventId:Joi.string().uuid().allow(null),
    templateId:    Joi.string().uuid().allow(null),
    reminderType:  Joi.string().max(100).required(),
    channel:       Joi.string().valid(...channels).required(),
    scheduledAt:   Joi.date().min('now').required(),
    messageBody:   Joi.string().max(4096).allow('', null),
    messageSubject:Joi.string().max(200).allow('', null),
  }),

  // Query params
  listQuery: Joi.object({
    page:     Joi.number().integer().min(1).default(1),
    limit:    Joi.number().integer().min(1).max(100).default(25),
    search:   Joi.string().max(100).allow('', null),
    status:   Joi.string().allow('', null),
    channel:  Joi.string().valid(...channels, '').allow(null),
    from:     Joi.date().allow(null),
    to:       Joi.date().allow(null),
    sortBy:   Joi.string().valid('created_at','name','last_visit_at','next_due_date').default('created_at'),
    sortDir:  Joi.string().valid('asc','desc').default('desc'),
  }),
};

module.exports = { validate, schemas };
