# Shih-Fu CRM+ — Backend API

Retention-first operating system for Indian service businesses.
Built with **Node.js + Express + PostgreSQL**.

---

## Tech Stack

| Layer        | Technology                              |
|--------------|-----------------------------------------|
| Runtime      | Node.js 18+                             |
| Framework    | Express 4                               |
| Database     | PostgreSQL 15 (Supabase recommended)    |
| Auth         | JWT (access + refresh tokens)           |
| SMS          | Twilio (TRAI DLT registered)            |
| WhatsApp     | Meta WhatsApp Business API              |
| Email        | Nodemailer + SendGrid / Zoho            |
| Scheduling   | node-cron (hourly reminder processing)  |
| Validation   | Joi                                     |
| Logging      | Winston                                 |

---

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, Twilio, Meta tokens

# 3. Run migrations
npm run migrate

# 4. Seed demo data (optional)
npm run seed

# 5. Start development server
npm run dev
# API available at http://localhost:4000/api/v1
```

---

## Database Schema

```
businesses          — Multi-tenant root. Each business is isolated.
  └── staff         — Users who log into the dashboard (owner/manager/staff)
  └── customers     — Customer records (one per phone per business)
        └── customer_entities — Pets (vet) or vehicles (auto)
        └── service_events    — Every visit/transaction logged here
        └── reminders         — Scheduled follow-up messages
        └── message_log       — Immutable delivery audit trail

reminder_templates  — Business-configurable reminder rules per service type
audit_log           — All create/update/delete actions by staff
```

**Key PostgreSQL features used:**
- `uuid-ossp` — UUID primary keys
- `pg_trgm`   — Fuzzy name/phone search
- `citext`    — Case-insensitive email storage
- Row-level triggers for `updated_at`, `next_due_date` auto-computation,
  and `customer.total_visits` / `lifetime_value` auto-update

---

## API Endpoints

### Auth
```
POST   /api/v1/auth/register    Create business + owner account
POST   /api/v1/auth/login       Login → access + refresh tokens
POST   /api/v1/auth/refresh     Refresh access token
GET    /api/v1/auth/me          Current user profile
POST   /api/v1/auth/logout      Logout
```

### Customers
```
GET    /api/v1/customers              Paginated list (search, filter, sort)
POST   /api/v1/customers              Create customer (+ optional pet/entity)
GET    /api/v1/customers/:id          Full customer profile (events, reminders)
PATCH  /api/v1/customers/:id          Update customer fields
DELETE /api/v1/customers/:id          Soft delete + PII anonymisation
POST   /api/v1/customers/import       Bulk CSV import (max 500/batch)
```

### Service Events
```
GET    /api/v1/service-events                       Paginated event log
POST   /api/v1/service-events                       Log event → auto-schedule reminder
GET    /api/v1/service-events/:id                   Event detail
GET    /api/v1/service-events/customer/:customerId  All events for a customer
```

### Reminders
```
GET    /api/v1/reminders               Reminder queue (filter by status/channel)
GET    /api/v1/reminders/summary       KPI counts (overdue/today/upcoming/sent)
POST   /api/v1/reminders               Create reminder manually
POST   /api/v1/reminders/:id/send      Send specific reminder now
POST   /api/v1/reminders/send-overdue  Bulk send all overdue reminders
PATCH  /api/v1/reminders/:id/skip      Skip a reminder
```

### Analytics
```
GET    /api/v1/analytics/dashboard    Overview KPIs (used by main dashboard)
GET    /api/v1/analytics/retention    Retention summary + churn risk list
GET    /api/v1/analytics/revenue      Revenue breakdown + reminder ROI
```

### System
```
GET    /health                         Health check + DB status
```

---

## Authentication

All endpoints (except `/auth/*` and `/health`) require:

```
Authorization: Bearer <accessToken>
```

Tokens expire after **7 days** (access) and **30 days** (refresh).

---

## India-Specific Compliance

### SMS — TRAI DLT
- All SMS sent through Twilio with DLT-registered sender ID
- DLT entity ID and template ID configurable via environment
- Messages capped at 1,530 characters (multi-part compliance)

### WhatsApp — Meta Business API
- Uses official Meta Graph API (not unofficial libraries)
- Requires verified Meta Business account and phone number ID
- Message templates must be pre-approved by Meta for transactional use

### Consent & Privacy
- `opted_in_*` flags per channel stored on each customer record
- `opted_in_at` / `opted_out_at` timestamps for audit
- Cron job checks opt-in status before every send
- Soft delete anonymises customer PII on removal

---

## Reminder Automation Flow

```
Service event logged
        │
        ▼
System looks for matching reminder_template
(by service_category or service_type)
        │
        ▼
Computes next_due_date = event_date + remind_after_days
        │
        ▼
Creates reminders row (status: 'scheduled')
        │
        ▼
Cron runs every hour — picks up all due reminders
        │
        ├── Checks opted_in for channel
        ├── Renders message with customer/pet variables
        ├── Dispatches via WhatsApp / SMS / Email
        └── Logs to message_log, updates reminders.status
```

---

## Environment Variables

See `.env.example` for full reference. Minimum required:

```env
DATABASE_URL=postgresql://...
JWT_SECRET=<min 32 chars>
PORT=4000
NODE_ENV=development
```

---

## Project Structure

```
shihfu-api/
├── src/
│   ├── server.js              Express app + startup
│   ├── routes/
│   │   ├── auth.js            Register, login, JWT
│   │   ├── customers.js       CRUD + bulk import
│   │   ├── serviceEvents.js   Event logging + reminder scheduling
│   │   ├── reminders.js       Queue management + send dispatch
│   │   └── analytics.js       Dashboard + retention + revenue
│   ├── middleware/
│   │   ├── auth.js            JWT verify, role guard, business isolation
│   │   └── validate.js        Joi schemas for all routes
│   ├── services/
│   │   ├── messaging.js       WhatsApp / SMS / Email dispatch
│   │   └── reminderCron.js    Scheduled reminder processor
│   └── utils/
│       ├── logger.js          Winston logger
│       └── response.js        Standardised JSON response helpers
├── config/
│   └── database.js            PostgreSQL pool + query helpers
├── migrations/
│   ├── 001_schema.sql         Full database schema
│   └── run.js                 Migration runner
├── seeds/
│   └── run.js                 Demo data (3 businesses, customers, events)
├── .env.example
├── package.json
└── README.md
```
