// tests/e2e.js
// End-to-end API tests against a running server. Creates its own throwaway
// businesses (emails e2e-*@example.com) and deletes them afterwards.
//
//   1. Start the API with high rate limits so the run isn't throttled:
//        AUTH_RATE_LIMIT_MAX=100000 RATE_LIMIT_MAX=100000 RESET_RATE_LIMIT_MAX=100000 npm start
//   2. node tests/e2e.js            (BASE=http://localhost:4000 by default)
//
// Runs against whatever DATABASE_URL points at, so only ever use a
// database you are happy to write throwaway rows into.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE = process.env.BASE || 'http://localhost:4000';
const API  = `${BASE}/api/v1`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const RUN  = Date.now().toString(36);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++; failures.push(`${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail).slice(0, 300) : ''}`);
  console.log(`  FAIL  ${name}${detail !== undefined ? '  ->  ' + JSON.stringify(detail).slice(0, 200) : ''}`);
}
const section = (t) => console.log(`\n== ${t}`);

async function call(method, path, { token, body, raw, headers } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: json, data: json?.data };
}

let phoneSeq = 0;
const phone = () => `9${String(700000000 + Math.floor(Math.random() * 99999999) + (phoneSeq++)).slice(0, 9)}`.slice(0, 10);
const email = (tag) => `e2e-${tag}-${RUN}@example.com`;

async function register(tag, vertical = 'veterinary') {
  const r = await call('POST', '/auth/register', { body: {
    businessName: `E2E ${tag}`, ownerName: 'Test Owner', phone: phone(), email: email(tag),
    password: 'Passw0rd!x', vertical, city: 'Bengaluru',
  }});
  return { ...r, token: r.data?.accessToken, staff: r.data?.staff, email: email(tag) };
}

async function main() {
  const health = await fetch(`${BASE}/health`).then(r => r.json()).catch(() => null);
  if (!health || health.database !== 'connected') { console.error('API not reachable at ' + BASE); process.exit(2); }

  // ───────────────────────────────────────────────────────────────
  section('Server basics');
  {
    let r = await call('GET', '/nope-route');
    check('unknown route -> 404 JSON', r.status === 404 && r.body?.success === false, r.status);
    r = await call('POST', '/auth/login', { raw: '{bad json' });
    check('malformed JSON -> 400 (not 500)', r.status === 400, r.status);
    r = await call('GET', '/customers');
    check('protected route without token -> 401', r.status === 401, r.status);
    r = await call('GET', '/customers', { token: 'garbage.token.value' });
    check('garbage token -> 401', r.status === 401, r.status);
    const pre = await fetch(`${API}/customers`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    check('CORS preflight for the web app allowed', pre.status === 204 && !!pre.headers.get('access-control-allow-origin'), pre.status);
    const helmet = await fetch(`${BASE}/health`);
    check('security headers present (helmet)', !!helmet.headers.get('x-content-type-options'));
  }

  // ───────────────────────────────────────────────────────────────
  section('Registration: every industry, and bad input');
  const verticals = ['auto_repair','veterinary','salon_spa','home_cleaning','ac_maintenance','pest_control','healthcare_eye','healthcare_dental','fitness_wellness','real_estate'];
  for (const v of verticals) {
    const r = await register(`v-${v}`, v);
    check(`register as ${v}`, r.status === 201 && r.staff?.vertical === v && r.staff?.businessName, [r.status, r.body?.message]);
  }
  const A = await register('A', 'veterinary');
  const B = await register('B', 'auto_repair');
  check('A and B created', A.token && B.token);
  check('register returns full staff shape', A.staff?.businessId && A.staff?.businessName === 'E2E A' && A.staff?.plan && A.staff?.role === 'owner', A.staff);
  {
    let r = await call('POST', '/auth/register', { body: { businessName: 'Dup', ownerName: 'Dup Owner', phone: phone(), email: A.email, password: 'Passw0rd!x', vertical: 'veterinary' } });
    check('duplicate email -> 409', r.status === 409 && /already exists/i.test(r.body?.message || ''), r.status);
    r = await call('POST', '/auth/register', { body: { businessName: 'Dup', ownerName: 'Dup Owner', phone: phone(), email: A.email.toUpperCase(), password: 'Passw0rd!x', vertical: 'veterinary' } });
    check('duplicate email differing only by case -> 409', r.status === 409, r.status);
    const bad = (label, patch, expectStatus = 400) => call('POST', '/auth/register', { body: { businessName: 'X Biz', ownerName: 'X Owner', phone: phone(), email: email('bad'), password: 'Passw0rd!x', vertical: 'veterinary', ...patch } })
      .then(res => check(`register rejects ${label}`, res.status === expectStatus, [res.status, res.body?.message]));
    await bad('bad phone', { phone: '12345' });
    await bad('phone starting 5', { phone: '5123456789' });
    await bad('short password', { password: 'short' });
    await bad('invalid vertical', { vertical: 'plumbing' });
    await bad('missing business name', { businessName: '' });
    await bad('invalid email', { email: 'not-an-email' });
    await bad('overlong password (>72)', { password: 'x'.repeat(80) });
  }

  // ───────────────────────────────────────────────────────────────
  section('Login, profile, password change');
  {
    let r = await call('POST', '/auth/login', { body: { email: A.email, password: 'Passw0rd!x' } });
    check('login ok', r.status === 200 && r.data?.accessToken, r.status);
    r = await call('POST', '/auth/login', { body: { email: A.email, password: 'wrong-password' } });
    check('wrong password -> 401', r.status === 401, r.status);
    r = await call('POST', '/auth/login', { body: { email: 'nobody-e2e@example.com', password: 'whatever12' } });
    check('unknown email -> 401 (same message as wrong password)', r.status === 401 && r.body?.message === 'Invalid email or password', r.body);
    r = await call('POST', '/auth/login', { body: { email: A.email.toUpperCase(), password: 'Passw0rd!x' } });
    check('login is case-insensitive on email', r.status === 200, r.status);

    r = await call('GET', '/auth/me', { token: A.token });
    check('/auth/me returns profile incl. business phone', r.status === 200 && r.data?.business_name === 'E2E A' && r.data?.business_phone, r.data);
    r = await call('PATCH', '/auth/me', { token: A.token, body: { name: 'Renamed Owner', phone: '9876500001' } });
    check('update profile', r.status === 200, r.body);
    r = await call('GET', '/auth/me', { token: A.token });
    check('profile change persisted', r.data?.name === 'Renamed Owner' && r.data?.business_phone === '9876500001', r.data);
    r = await call('PATCH', '/auth/me', { token: A.token, body: { phone: '123' } });
    check('profile rejects bad phone', r.status === 400, r.status);
    r = await call('PATCH', '/auth/me', { token: A.token, body: {} });
    check('profile rejects empty update', r.status === 400, r.status);

    r = await call('POST', '/auth/change-password', { token: A.token, body: { currentPassword: 'nope-nope', newPassword: 'NewPassw0rd!' } });
    check('change-password wrong current -> 400', r.status === 400, r.status);
    r = await call('POST', '/auth/change-password', { token: A.token, body: { currentPassword: 'Passw0rd!x', newPassword: 'Passw0rd!x' } });
    check('change-password same as current -> 400', r.status === 400, r.status);
    r = await call('POST', '/auth/change-password', { token: A.token, body: { currentPassword: 'Passw0rd!x', newPassword: 'short' } });
    check('change-password too short -> 400', r.status === 400, r.status);
    r = await call('POST', '/auth/change-password', { token: A.token, body: { currentPassword: 'Passw0rd!x', newPassword: 'NewPassw0rd!' } });
    check('change-password ok', r.status === 200, r.body);
    r = await call('POST', '/auth/login', { body: { email: A.email, password: 'NewPassw0rd!' } });
    check('login with new password', r.status === 200, r.status);
    r = await call('POST', '/auth/login', { body: { email: A.email, password: 'Passw0rd!x' } });
    check('old password no longer works', r.status === 401, r.status);
    A.token = (await call('POST', '/auth/login', { body: { email: A.email, password: 'NewPassw0rd!' } })).data.accessToken;
  }

  // ───────────────────────────────────────────────────────────────
  section('Forgot / reset password (OTP)');
  {
    let r = await call('POST', '/auth/forgot-password', { body: { email: 'ghost-e2e@example.com' } });
    const ghostMsg = r.body?.message;
    check('unknown email gets a normal-looking success', r.status === 200, r.status);
    r = await call('POST', '/auth/forgot-password', { body: { email: A.email } });
    check('known email gets the identical response (no account enumeration)', r.status === 200 && r.body?.message === ghostMsg, r.body);
    r = await call('POST', '/auth/forgot-password', { body: { email: 'bad' } });
    check('forgot-password rejects malformed email', r.status === 400, r.status);

    const { rows: [st] } = await pool.query('SELECT id FROM staff WHERE email = $1', [A.email]);
    await pool.query('DELETE FROM password_reset_otps WHERE staff_id = $1', [st.id]);
    const plant = async (otp, { expired = false, attempts = 0 } = {}) => {
      await pool.query('DELETE FROM password_reset_otps WHERE staff_id = $1', [st.id]);
      await pool.query(`INSERT INTO password_reset_otps (staff_id, otp_hash, expires_at, attempt_count) VALUES ($1,$2, NOW() + ($3 || ' minutes')::interval, $4)`,
        [st.id, await bcrypt.hash(otp, 4), expired ? '-5' : '10', attempts]);
    };

    await plant('123456');
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '000000', newPassword: 'ResetPassw0rd!' } });
    check('wrong OTP rejected', r.status === 400, r.status);
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '12345', newPassword: 'ResetPassw0rd!' } });
    check('short OTP rejected by validation', r.status === 400, r.status);
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '123456', newPassword: 'short' } });
    check('reset rejects weak new password (OTP not consumed)', r.status === 400, r.status);
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '123456', newPassword: 'ResetPassw0rd!' } });
    check('correct OTP resets password', r.status === 200, r.body);
    r = await call('POST', '/auth/login', { body: { email: A.email, password: 'ResetPassw0rd!' } });
    check('login with reset password', r.status === 200, r.status);
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '123456', newPassword: 'AnotherPassw0rd!' } });
    check('OTP cannot be reused', r.status === 400, r.status);

    await plant('654321', { expired: true });
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '654321', newPassword: 'ResetPassw0rd!2' } });
    check('expired OTP rejected', r.status === 400, r.status);

    await plant('111222');
    for (let i = 0; i < 5; i++) await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '999999', newPassword: 'ResetPassw0rd!3' } });
    r = await call('POST', '/auth/reset-password', { body: { email: A.email, otp: '111222', newPassword: 'ResetPassw0rd!3' } });
    check('after 5 wrong guesses even the right OTP is locked out (429)', r.status === 429, r.status);
    r = await call('POST', '/auth/reset-password', { body: { email: 'ghost-e2e@example.com', otp: '123456', newPassword: 'ResetPassw0rd!' } });
    check('reset for unknown email fails generically', r.status === 400 && r.body?.message === 'Invalid or expired code', r.body);
    A.token = (await call('POST', '/auth/login', { body: { email: A.email, password: 'ResetPassw0rd!' } })).data.accessToken;
  }

  // ───────────────────────────────────────────────────────────────
  section('Customers: create, read, update, validation');
  const cA = {};
  {
    const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    let r = await call('POST', '/customers', { token: A.token, body: {
      name: 'Asha Verma', phone: '9811100001', email: 'asha@example.com', city: 'Bengaluru', address: '12 MG Road',
      preferredChannel: 'email', optedInEmail: true,
      entity: { name: 'Bruno', entityType: 'veterinary', assetData: { entityName: 'Bruno', petType: 'Dog', breed: 'Beagle' }, retentionData: { nextGroomingDate: future } },
    }});
    check('create customer with pet + due date', r.status === 201 && r.data?.customer?.id, [r.status, r.body?.message]);
    cA.id = r.data?.customer?.id;
    r = await call('GET', `/customers/${cA.id}`, { token: A.token });
    check('customer detail includes address, entity data and the auto-created reminder',
      r.data?.address === '12 MG Road' && r.data?.entities?.[0]?.asset_data?.breed === 'Beagle' && r.data?.reminders?.some(x => x.reminder_type === 'Next Grooming Date' && x.status === 'scheduled'), r.data && { addr: r.data.address, ent: r.data.entities, rem: r.data.reminders });
    cA.entityId = r.data?.entities?.[0]?.id;

    r = await call('POST', '/customers', { token: A.token, body: { name: 'Dup Phone', phone: '9811100001' } });
    check('duplicate phone in same business -> 409', r.status === 409, r.status);
    const badC = (label, body) => call('POST', '/customers', { token: A.token, body: { name: 'Val Test', phone: phone(), ...body } }).then(x => check(`customer rejects ${label}`, x.status === 400, [x.status, x.body?.message]));
    await badC('bad phone', { phone: '999' });
    await badC('bad email', { email: 'nope' });
    await badC('bad channel', { preferredChannel: 'pigeon' });
    await badC('bad pincode', { pincode: '12' });
    await badC('1-char name', { name: 'A' });
    await badC('entity junk fields are stripped not errored?', { entity: { name: 'x', assetData: 'not-an-object' } });

    r = await call('PATCH', `/customers/${cA.id}`, { token: A.token, body: { name: 'Asha V', phone: '9811100002', address: 'New Address 5', entity: { name: 'Bruno', entityType: 'veterinary', assetData: { entityName: 'Bruno', petType: 'Dog', breed: 'Pug', weight: '11.5' }, retentionData: {} } } });
    check('edit customer (name, phone, address, pet)', r.status === 200, r.body);
    r = await call('GET', `/customers/${cA.id}`, { token: A.token });
    check('edits persisted', r.data?.name === 'Asha V' && r.data?.phone === '9811100002' && r.data?.address === 'New Address 5' && r.data?.entities?.[0]?.asset_data?.weight === '11.5', r.data && { n: r.data.name, p: r.data.phone, a: r.data.address });
    r = await call('PATCH', `/customers/${cA.id}`, { token: A.token, body: {} });
    check('empty PATCH -> 400', r.status === 400, r.status);
    r = await call('PATCH', `/customers/${cA.id}`, { token: A.token, body: { status: 'exploded' } });
    check('invalid status -> 400', r.status === 400, r.status);
    r = await call('GET', '/customers/not-a-uuid', { token: A.token });
    check('malformed customer id -> clean error, not 500', r.status === 404 || r.status === 400, [r.status, r.body?.message]);
    r = await call('GET', '/customers/00000000-0000-0000-0000-000000000000', { token: A.token });
    check('unknown customer id -> 404', r.status === 404, r.status);

    // second phone taken by another existing customer
    const c2 = await call('POST', '/customers', { token: A.token, body: { name: 'Second Cust', phone: '9811100003', preferredChannel: 'sms', optedInSms: true } });
    cA.id2 = c2.data?.customer?.id;
    r = await call('PATCH', `/customers/${cA.id2}`, { token: A.token, body: { phone: '9811100002' } });
    check('changing phone onto an existing number -> 409', r.status === 409, r.status);

    r = await call('GET', '/customers?search=asha', { token: A.token });
    check('search by name', r.status === 200 && r.data.some(c => c.id === cA.id), r.status);
    r = await call('GET', "/customers?search=' OR 1=1 --", { token: A.token });
    check('SQL-injection-looking search is harmless', r.status === 200 && r.data.length === 0, [r.status, r.data?.length]);
    r = await call('GET', '/customers?sortBy=password_hash', { token: A.token });
    check('unlisted sort column rejected', r.status === 400, r.status);
    r = await call('GET', '/customers?limit=1000', { token: A.token });
    check('limit above 100 rejected', r.status === 400, r.status);
  }

  // ───────────────────────────────────────────────────────────────
  section('Tenant isolation (business B must never touch business A)');
  {
    let r = await call('GET', `/customers/${cA.id}`, { token: B.token });
    check('B cannot read A\'s customer', r.status === 404, r.status);
    r = await call('PATCH', `/customers/${cA.id}`, { token: B.token, body: { name: 'Hacked' } });
    check('B cannot edit A\'s customer', r.status === 404, r.status);
    r = await call('GET', '/customers?limit=100', { token: B.token });
    check('B\'s list contains none of A\'s customers', r.status === 200 && !r.data.some(c => c.id === cA.id), r.data?.length);
    r = await call('POST', '/service-events', { token: B.token, body: { customerId: cA.id, serviceType: 'Sneaky Service' } });
    check('B cannot log a service on A\'s customer', r.status === 404, [r.status, r.body?.message]);
    const remsA = (await call('GET', `/customers/${cA.id}`, { token: A.token })).data.reminders;
    r = await call('POST', `/reminders/${remsA[0].id}/send`, { token: B.token });
    check('B cannot send A\'s reminder', r.status === 404, r.status);
    r = await call('PATCH', `/reminders/${remsA[0].id}/skip`, { token: B.token });
    check('B cannot skip A\'s reminder', r.status === 404, r.status);
    r = await call('GET', '/reminders?limit=100', { token: B.token });
    check('B\'s reminder queue is empty of A\'s', r.status === 200 && !r.data.some(x => x.customer_id === cA.id), r.data?.length);
    r = await call('POST', '/reminders', { token: B.token, body: { customerId: cA.id, reminderType: 'X', channel: 'sms', scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
    check('B cannot create a reminder for A\'s customer', r.status === 404, r.status);
    r = await call('POST', '/service-events', { token: A.token, body: { customerId: cA.id, serviceType: 'Vaccination', entityId: cA.entityId } });
    const evA = r.data?.event?.id;
    r = await call('GET', `/service-events/${evA}`, { token: B.token });
    check('B cannot read A\'s service event', r.status === 404, r.status);
    r = await call('GET', `/service-events/customer/${cA.id}`, { token: B.token });
    check('B cannot list service events for A\'s customer', r.status === 200 && r.data.length === 0, [r.status, r.data?.length]);
    const bCust = await call('POST', '/customers', { token: B.token, body: { name: 'B Customer', phone: '9822200001' } });
    r = await call('POST', '/service-events', { token: B.token, body: { customerId: bCust.data.customer.id, serviceType: 'Oil Change', entityId: cA.entityId } });
    check('B cannot attach A\'s pet/entity to its own service event', r.status >= 400 && r.status < 500, [r.status, r.body?.message]);
    r = await call('POST', '/customers', { token: B.token, body: { name: 'Same Phone Other Biz', phone: '9811100002' } });
    check('same phone number may exist in two different businesses', r.status === 201, [r.status, r.body?.message]);

    // campaigns + check-in link isolation
    const camp = await call('POST', '/campaigns', { token: A.token, body: { label: 'Iso Test', messageBody: 'hello', channels: ['sms'], scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString() } });
    cA.campaignId = camp.data?.id;
    r = await call('PATCH', `/campaigns/${cA.campaignId}/cancel`, { token: B.token });
    check('B cannot cancel A\'s campaign', r.status === 404, r.status);
    r = await call('GET', '/campaigns', { token: B.token });
    check('B does not see A\'s campaigns', r.status === 200 && !r.data.some(c => c.id === cA.campaignId), r.data?.length);
    const la = (await call('GET', '/business/checkin-link', { token: A.token })).data.token;
    const lb = (await call('GET', '/business/checkin-link', { token: B.token })).data.token;
    check('each business has its own check-in token', la && lb && la !== lb);
    cA.checkin = la;
  }

  // ───────────────────────────────────────────────────────────────
  section('Service events and reminders');
  {
    let r = await call('POST', '/service-events', { token: A.token, body: { customerId: cA.id, serviceType: 'Annual Vaccination', serviceCategory: 'vaccination', followUpDays: 30, amountCharged: 1200, paymentMethod: 'upi', staffName: 'Dr X', notes: 'ok' } });
    check('log service with follow-up', r.status === 201 && r.data?.event?.id, [r.status, r.body?.message]);
    check('follow-up reminder auto-scheduled ~30 days out', !!r.data?.reminder && Math.abs(new Date(r.data.reminder.scheduled_at) - (Date.now() + 30 * 86400000)) < 3 * 86400000, r.data?.reminder?.scheduled_at);
    r = await call('POST', '/service-events', { token: A.token, body: { customerId: cA.id, serviceType: 'Checkup' } });
    check('log service without follow-up', r.status === 201 && !r.data?.reminder, [r.status, r.data?.reminder]);
    const evBad = (label, body) => call('POST', '/service-events', { token: A.token, body: { customerId: cA.id, serviceType: 'Chk', ...body } }).then(x => check(`service event rejects ${label}`, x.status === 400, [x.status, x.body?.message]));
    await evBad('negative amount', { amountCharged: -5 });
    await evBad('future date', { eventDate: new Date(Date.now() + 5 * 86400000).toISOString() });
    await evBad('bad payment method', { paymentMethod: 'bitcoin' });
    await evBad('follow-up of 0 days', { followUpDays: 0 });
    await evBad('follow-up beyond 2 years', { followUpDays: 5000 });
    r = await call('POST', '/service-events', { token: A.token, body: { customerId: 'nope', serviceType: 'Chk' } });
    check('service event with bad customer id -> 400', r.status === 400, r.status);
    r = await call('POST', '/service-events', { token: A.token, body: { customerId: cA.id, serviceType: 'Chk', serviceData: { vetName: 'x' } } });
    check('unknown extra field (serviceData) tolerated', r.status === 201, [r.status, r.body?.message]);
    r = await call('GET', '/service-events?limit=50', { token: A.token });
    check('service log lists events with customer name', r.status === 200 && r.data.length >= 3 && r.data[0].customer_name, r.data?.[0]);
    const cust = (await call('GET', `/customers/${cA.id}`, { token: A.token })).data;
    check('visit count and last visit updated on the customer', cust.total_visits >= 3 && cust.last_visit_at, { v: cust.total_visits, l: cust.last_visit_at });

    // reminders: send on email without gmail connected
    const rems = (await call('GET', `/customers/${cA.id}`, { token: A.token })).data.reminders.filter(x => x.status === 'scheduled');
    const emailRem = rems.find(x => x.channel === 'email') || rems[0];
    r = await call('POST', `/reminders/${emailRem.id}/send`, { token: A.token });
    check('email reminder without Gmail connected fails with a clear reason', r.status === 502 && /Gmail/i.test(r.body?.message || ''), [r.status, r.body?.message]);
    const after = await pool.query('SELECT status FROM reminders WHERE id = $1', [emailRem.id]);
    check('failed send is recorded as failed, never as sent', after.rows[0].status === 'failed', after.rows[0]);
    const ml = await pool.query('SELECT status, message_body FROM message_log WHERE reminder_id = $1', [emailRem.id]);
    check('failed send is in the audit log with a message body', ml.rows.length === 1 && ml.rows[0].status === 'failed' && ml.rows[0].message_body, ml.rows);
    r = await call('POST', `/reminders/${emailRem.id}/send`, { token: A.token });
    check('a failed reminder can be retried (not stuck)', r.status !== 400, r.status);
    const smsRem = rems.find(x => x.id !== emailRem.id);
    r = await call('PATCH', `/reminders/${smsRem.id}/skip`, { token: A.token });
    check('skip a reminder', r.status === 200, r.status);
    r = await call('PATCH', `/reminders/${smsRem.id}/skip`, { token: A.token });
    check('skipping twice -> 404', r.status === 404, r.status);
    r = await call('GET', '/reminders/summary', { token: A.token });
    check('reminder summary returns counts', r.status === 200 && ['overdue','today','upcoming','sent_this_month'].every(k => k in r.data), r.data);
    r = await call('GET', '/reminders?limit=100', { token: A.token });
    check('reminder list has urgency and days_until_due', r.status === 200 && r.data.every(x => x.urgency && x.days_until_due !== undefined), r.data?.[0]);
    r = await call('POST', '/reminders/send-overdue', { token: A.token });
    check('send-overdue with nothing overdue is fine', r.status === 200, [r.status, r.body?.message]);
    r = await call('POST', '/reminders', { token: A.token, body: { customerId: cA.id, reminderType: 'Manual', channel: 'sms', scheduledAt: new Date(Date.now() - 86400000).toISOString() } });
    check('manual reminder in the past rejected', r.status === 400, r.status);
  }

  // ───────────────────────────────────────────────────────────────
  section('Removing and re-adding customers');
  {
    const c = await call('POST', '/customers', { token: A.token, body: { name: 'Remove Me', phone: '9833300001', preferredChannel: 'sms', optedInSms: true, entity: { name: 'Rex', entityType: 'veterinary', assetData: { entityName: 'Rex' }, retentionData: { nextCheckupDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) } } } });
    const id = c.data.customer.id;
    let r = await call('PATCH', `/customers/${id}`, { token: A.token, body: { status: 'opted_out' } });
    check('remove customer', r.status === 200, r.status);
    r = await call('GET', '/customers?limit=100', { token: A.token });
    check('removed customer disappears from the list', !r.data.some(x => x.id === id), r.data.length);
    const rem = await pool.query(`SELECT status FROM reminders WHERE customer_id = $1`, [id]);
    check('removed customer\'s reminders are cancelled', rem.rows.length > 0 && rem.rows.every(x => x.status !== 'scheduled'), rem.rows);
    r = await call('GET', '/reminders?limit=100', { token: A.token });
    check('cancelled reminders are not left in the active queue as scheduled', !r.data.some(x => x.customer_id === id && x.status === 'scheduled'));
    r = await call('POST', '/customers', { token: A.token, body: { name: 'Remove Me Again', phone: '9833300001', preferredChannel: 'sms', optedInSms: true } });
    check('re-adding a removed number restores the customer (no dead-end 409)', r.status === 201 && r.data?.customer?.id === id && r.data.customer.status === 'active', [r.status, r.body?.message]);
    r = await call('GET', '/customers?limit=100', { token: A.token });
    check('restored customer is back in the list', r.data.some(x => x.id === id));
  }

  // ───────────────────────────────────────────────────────────────
  section('Plan limit and pagination');
  {
    const P = await register('P', 'salon_spa');
    const { rows: [b] } = await pool.query('SELECT id FROM businesses WHERE email = $1', [P.email]);
    await pool.query('UPDATE businesses SET max_customers = 3 WHERE id = $1', [b.id]);
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await call('POST', '/customers', { token: P.token, body: { name: `Limit ${i}`, phone: `9844400${String(i).padStart(3, '0')}` } })).status);
    check('customer limit enforced (3 ok, 4th blocked with 403)', results.join() === '201,201,201,403', results);
    await pool.query('UPDATE businesses SET max_customers = 500 WHERE id = $1', [b.id]);
    // bulk insert 130 to test paging
    await pool.query(`INSERT INTO customers (business_id, name, phone) SELECT $1, 'Bulk ' || g, '95000' || LPAD(g::text, 5, '0') FROM generate_series(1,130) g`, [b.id]);
    let p1 = await call('GET', '/customers?limit=100&page=1', { token: P.token });
    let p2 = await call('GET', '/customers?limit=100&page=2', { token: P.token });
    check('pagination: 100 on page 1, remainder on page 2', p1.data.length === 100 && p2.data.length === 33 && p1.body.pagination.total === 133 && p1.body.pagination.totalPages === 2, [p1.data.length, p2.data.length, p1.body.pagination]);
    check('pages do not overlap', !p2.data.some(x => p1.data.find(y => y.id === x.id)));
  }

  // ───────────────────────────────────────────────────────────────
  section('Campaigns (Send All)');
  {
    const status = await call('GET', '/business/channel-status', { token: A.token });
    check('channel status reports email not connected', status.status === 200 && status.data.email.available === false && /Gmail/.test(status.data.email.reason), status.data);
    let r = await call('POST', '/campaigns', { token: A.token, body: { label: 'Diwali', messageBody: 'Happy Diwali!', channels: ['email'], scheduledAt: new Date().toISOString() } });
    check('email campaign refused while Gmail not connected', r.status === 400 && /Gmail/.test(r.body?.message || ''), [r.status, r.body?.message]);
    r = await call('POST', '/campaigns', { token: A.token, body: { label: 'Later', messageBody: 'Offer', channels: ['sms'], scheduledAt: new Date(Date.now() + 9 * 86400000).toISOString() } });
    check('schedule a future campaign', r.status === 201 && r.data?.status === 'scheduled', [r.status, r.body?.message]);
    const id = r.data?.id;
    r = await call('GET', '/campaigns', { token: A.token });
    check('scheduled campaign appears in the list', r.data.some(c => c.id === id));
    r = await call('PATCH', `/campaigns/${id}/cancel`, { token: A.token });
    check('cancel scheduled campaign', r.status === 200, r.status);
    r = await call('PATCH', `/campaigns/${id}/cancel`, { token: A.token });
    check('cancelling twice -> 404', r.status === 404, r.status);
    const cb = (label, body) => call('POST', '/campaigns', { token: A.token, body: { label: 'X Camp', messageBody: 'hi', channels: ['sms'], scheduledAt: new Date().toISOString(), ...body } }).then(x => check(`campaign rejects ${label}`, x.status === 400, [x.status, x.body?.message]));
    await cb('empty message', { messageBody: '' });
    await cb('no channels', { channels: [] });
    await cb('unknown channel', { channels: ['fax'] });
    await cb('1-char name', { label: 'X' });
    await cb('message over 1000 chars', { messageBody: 'x'.repeat(1001) });
    await cb('missing date', { scheduledAt: undefined });
    r = await call('POST', '/campaigns', { token: A.token, body: { label: 'Now SMS', messageBody: 'Hello everyone', channels: ['sms'], scheduledAt: new Date().toISOString() } });
    check('send-now campaign dispatches inline and reports counts', r.status === 201 && r.data?.status === 'sent' && typeof r.data.sent === 'number', [r.status, r.body?.message, r.data]);
    const logs = await pool.query('SELECT status, message_body FROM message_log WHERE campaign_id = $1', [r.data.id]);
    check('every recipient is in the audit log', logs.rows.length === (r.data.sent + r.data.failed), [logs.rows.length, r.data.sent, r.data.failed]);
    const optedOutTargets = await pool.query(`SELECT COUNT(*) FROM customers c JOIN message_log m ON m.customer_id = c.id AND m.campaign_id = $1 WHERE c.opted_in_sms = false OR c.status = 'opted_out'`, [r.data.id]);
    check('campaign never messages customers who did not opt in or were removed', Number(optedOutTargets.rows[0].count) === 0, optedOutTargets.rows);
  }

  // ───────────────────────────────────────────────────────────────
  section('Quick check-in form');
  {
    const t = cA.checkin;
    let r = await fetch(`${API}/public/checkin/${t}`).then(async x => ({ status: x.status, body: await x.json() }));
    check('public form loads business name + industry, no login', r.status === 200 && r.body.data.businessName === 'E2E A' && r.body.data.vertical === 'veterinary', r);
    const pub = (tok, body) => fetch(`${API}/public/checkin/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
    r = await pub(t, { name: 'Walk In', phone: '9855500001', channels: ['whatsapp', 'email'], email: 'walkin@example.com', entity: { name: 'Milo', assetData: { entityName: 'Milo', petType: 'Cat', breed: 'Persian' } } });
    check('check-in creates the customer', r.status === 201 && r.body.data.status === 'created', r);
    const row = await pool.query(`SELECT c.tags, c.source, c.opted_in_whatsapp, c.opted_in_email, c.opted_in_sms, c.opted_in_at, e.asset_data FROM customers c LEFT JOIN customer_entities e ON e.customer_id = c.id WHERE c.phone = '9855500001' AND c.business_id = $1`, [A.staff.businessId]);
    check('check-in tagged, consent recorded per channel, pet saved',
      row.rows[0]?.tags?.includes('checkin') && row.rows[0].source === 'checkin' && row.rows[0].opted_in_whatsapp && row.rows[0].opted_in_email && !row.rows[0].opted_in_sms && row.rows[0].opted_in_at && row.rows[0].asset_data?.breed === 'Persian', row.rows[0]);
    r = await pub(t, { name: 'Impostor', phone: '9855500001' });
    check('existing customer is not overwritten by an anonymous form', r.status === 200 && r.body.data.status === 'existing', r);
    const nm = await pool.query(`SELECT name FROM customers WHERE phone = '9855500001' AND business_id = $1`, [A.staff.businessId]);
    check('...and their record is untouched', nm.rows[0].name === 'Walk In', nm.rows);
    r = await pub(t, { name: 'No Consent', phone: '9855500002' });
    check('check-in with no channel ticked stores no consent', r.status === 201, r);
    const nc = await pool.query(`SELECT opted_in_whatsapp, opted_in_sms, opted_in_email, opted_in_at FROM customers WHERE phone = '9855500002' AND business_id = $1`, [A.staff.businessId]);
    check('...consent flags all false', !nc.rows[0].opted_in_whatsapp && !nc.rows[0].opted_in_sms && !nc.rows[0].opted_in_email && !nc.rows[0].opted_in_at, nc.rows);
    r = await pub(t, { name: 'X', phone: '9855500003' });
    check('check-in rejects 1-char name', r.status === 400, r.status);
    r = await pub(t, { name: 'Bad Phone', phone: '1234' });
    check('check-in rejects bad phone', r.status === 400, r.status);
    r = await pub(t, { name: 'Nested Junk', phone: '9855500004', entity: { assetData: { a: { b: 1 } } } });
    check('check-in rejects nested/object values', r.status === 400, r.status);
    r = await pub(t, { name: 'Huge', phone: '9855500005', entity: { assetData: { k: 'x'.repeat(500) } } });
    check('check-in rejects oversized values', r.status === 400, r.status);
    r = await pub(t, { name: '<script>alert(1)</script>', phone: '9855500006' });
    check('markup in a name is accepted as plain text', r.status === 201, r);
    r = await pub('does-not-exist', { name: 'Ghost Try', phone: '9855500007' });
    check('unknown token -> 404 and nothing created', r.status === 404, r);
    // regenerate
    r = await call('POST', '/business/checkin-link/regenerate', { token: A.token });
    const newTok = r.data?.token;
    check('regenerate gives a new token', r.status === 200 && newTok && newTok !== t, r.body);
    r = await fetch(`${API}/public/checkin/${t}`).then(x => x.status);
    check('the old link stops working immediately', r === 404, r);
    r = await fetch(`${API}/public/checkin/${newTok}`).then(x => x.status);
    check('the new link works', r === 200, r);
    const cust = await call('GET', '/customers?limit=100', { token: A.token });
    check('check-in customers show up for the business', cust.data.some(c => c.tags?.includes('checkin')), cust.data.length);
  }

  // ───────────────────────────────────────────────────────────────
  section('Analytics / dashboard endpoints');
  {
    for (const [name, tok] of [['populated business A', A.token], ['brand-new empty business', (await register('E', 'pest_control')).token]]) {
      for (const p of ['/analytics/dashboard', '/analytics/retention', '/analytics/revenue']) {
        const r = await call('GET', p, { token: tok });
        check(`${p} works for ${name}`, r.status === 200 && r.body?.success === true, [r.status, r.body?.message]);
      }
    }
    const d = await call('GET', '/analytics/dashboard', { token: A.token });
    check('dashboard KPIs are numbers, not blanks', d.data?.retention && d.data?.queue && Number(d.data.retention.total_customers) >= 3, d.data);
    const total = Number(d.data.retention.total_customers);
    const list = await call('GET', '/customers?limit=100', { token: A.token });
    check('dashboard total_customers equals the visible customer list (removed ones excluded)', total === list.body.pagination.total, [total, list.body.pagination.total]);
  }

  // ───────────────────────────────────────────────────────────────
  section('Email connection endpoints');
  {
    let r = await call('GET', '/email-auth/google/status', { token: A.token });
    check('status: not connected', r.status === 200 && r.data.connected === false, r.data);
    r = await call('GET', '/email-auth/google/connect-url', { token: A.token });
    const u = r.data?.url && new URL(r.data.url);
    check('connect URL asks only for send + email address', u && u.searchParams.get('scope') === 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email', u && u.searchParams.get('scope'));
    check('connect URL requests offline access (refresh token)', u && u.searchParams.get('access_type') === 'offline');
    r = await call('GET', '/email-auth/google/connect-url');
    check('connect URL requires login', r.status === 401);
    r = await fetch(`${API}/email-auth/google/callback?code=x&state=forged`, { redirect: 'manual' });
    check('OAuth callback with a forged state does not connect anything', (r.status === 302 || r.status === 301) && /email_error/.test(r.headers.get('location') || ''), [r.status, r.headers.get('location')]);
    r = await call('DELETE', '/email-auth/google/disconnect', { token: A.token });
    check('disconnect when nothing is connected is harmless', r.status === 200, r.status);
  }

  // ───────────────────────────────────────────────────────────────
  section('Messaging behaviour without providers configured');
  {
    const { execFileSync } = require('child_process');
    const probe = (env, code) => execFileSync(process.execPath, ['-e', code], { env: { ...process.env, ...env }, cwd: __dirname + '/..', encoding: 'utf8' });
    const wa = probe({ NODE_ENV: 'production', WHATSAPP_ACCESS_TOKEN: 'your_meta_access_token', WHATSAPP_PHONE_NUMBER_ID: '' }, `
      const m=require('./src/services/messaging');
      Promise.all([
        m.send({channel:'whatsapp',phone:'9000000000',message_body:'x'}),
        m.send({channel:'sms',phone:'9000000000',message_body:'x'}),
        m.send({channel:'email',email:'a@b.com',message_body:'x',business_id:'00000000-0000-0000-0000-000000000000'}),
        m.send({channel:'pigeon'}),
      ]).then(r=>{console.log(JSON.stringify(r));process.exit(0)})`);
    const res = JSON.parse(wa.trim().split('\n').pop());
    check('production: WhatsApp unconfigured fails honestly (no fake "sent")', res[0].success === false && /not set up/.test(res[0].error), res[0]);
    check('production: SMS unconfigured fails honestly', res[1].success === false && /not set up/.test(res[1].error), res[1]);
    check('email with no connected Gmail fails and says how to fix it', res[2].success === false && /Gmail/.test(res[2].error), res[2]);
    check('unknown channel fails cleanly', res[3].success === false, res[3]);
    const otpOut = probe({ NODE_ENV: 'production', SMTP_HOST: '' }, `
      const m=require('./src/services/messaging');
      m.sendOtpEmail({email:'a@b.com',otp:'424242',ownerName:'x'}).then(r=>{console.log('RESULT '+JSON.stringify(r));process.exit(0)})`);
    check('production: a reset code is never written to the logs', !otpOut.includes('424242'), otpOut.slice(0, 300));
    check('production: reset email with no sender available reports failure', /"success":false/.test(otpOut), otpOut.slice(-200));
    const grep = require('fs').readFileSync(__dirname + '/../src/services/messaging.js', 'utf8');
    check('no shared "send as Shih-Fu" SMTP path remains for customer email', !/sendEmailViaSmtp/.test(grep));
    check('email HTML has no dead "#" links', !/href="#"/.test(grep));
  }
}

async function cleanup() {
  const r = await pool.query(`DELETE FROM businesses WHERE email LIKE 'e2e-%@example.com' RETURNING id`);
  console.log(`\ncleaned up ${r.rowCount} test businesses`);
}

main().catch(e => { failed++; failures.push('CRASH: ' + (e.stack || e)); })
  .then(cleanup).catch(e => console.error('cleanup failed', e.message))
  .then(async () => {
    await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(failed ? 1 : 0);
  });
