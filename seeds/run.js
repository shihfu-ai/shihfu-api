// seeds/run.js
// Populates the database with realistic Indian demo data for all three verticals.
// Run: node seeds/run.js

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const { v4: uuid } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  console.log('Seeding database...\n');

  try {
    await client.query('BEGIN');

    // ─── Businesses ───────────────────────────────────────────────
    const businesses = [
      {
        id: uuid(), name: 'PawCare Veterinary Clinic', owner_name: 'Dr. Priya Sharma',
        phone: '+919876543210', email: 'priya@pawcare.in', city: 'Bengaluru',
        state: 'Karnataka', pincode: '560001', vertical: 'veterinary',
        preferred_language: 'en', whatsapp_number: '+919876543210',
        plan: 'growth', plan_status: 'active', max_customers: 2500,
        onboarded_at: new Date(),
      },
      {
        id: uuid(), name: 'Glam Studio', owner_name: 'Deepika Iyer',
        phone: '+918765432109', email: 'deepika@glamstudio.in', city: 'Mumbai',
        state: 'Maharashtra', pincode: '400001', vertical: 'salon_beauty',
        preferred_language: 'hi', whatsapp_number: '+918765432109',
        plan: 'starter', plan_status: 'active', max_customers: 500,
        onboarded_at: new Date(),
      },
      {
        id: uuid(), name: 'SpeedTrack Auto Services', owner_name: 'Suresh Anand',
        phone: '+917654321098', email: 'suresh@speedtrack.in', city: 'Chennai',
        state: 'Tamil Nadu', pincode: '600001', vertical: 'auto_repair',
        preferred_language: 'ta', whatsapp_number: '+917654321098',
        plan: 'growth', plan_status: 'active', max_customers: 2500,
        onboarded_at: new Date(),
      },
    ];

    const bizIds = [];
    for (const b of businesses) {
      const { rows } = await client.query(`
        INSERT INTO businesses
          (id, name, owner_name, phone, email, city, state, pincode,
           vertical, preferred_language, whatsapp_number, plan, plan_status,
           max_customers, onboarded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [b.id, b.name, b.owner_name, b.phone, b.email, b.city, b.state,
          b.pincode, b.vertical, b.preferred_language, b.whatsapp_number,
          b.plan, b.plan_status, b.max_customers, b.onboarded_at]);
      bizIds.push(rows[0].id);
      console.log(`  Business: ${b.name}`);
    }

    // ─── Staff (owners as admin users) ────────────────────────────
    const passwordHash = await bcrypt.hash('ShihFu@2024', 12);
    const staffData = [
      { business_id: bizIds[0], name: 'Dr. Priya Sharma',    email: 'priya@pawcare.in',    role: 'owner' },
      { business_id: bizIds[0], name: 'Dr. Arjun Nair',      email: 'arjun@pawcare.in',    role: 'staff' },
      { business_id: bizIds[1], name: 'Deepika Iyer',        email: 'deepika@glamstudio.in',role: 'owner' },
      { business_id: bizIds[2], name: 'Suresh Anand',        email: 'suresh@speedtrack.in', role: 'owner' },
      { business_id: bizIds[2], name: 'Ramesh Babu',         email: 'ramesh@speedtrack.in', role: 'staff' },
    ];
    for (const s of staffData) {
      await client.query(`
        INSERT INTO staff (business_id, name, email, password_hash, role)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id, email) DO NOTHING
      `, [s.business_id, s.name, s.email, passwordHash, s.role]);
    }
    console.log('  Staff created');

    // ─── Customers — Vet (bizIds[0]) ──────────────────────────────
    const vetCustomers = [
      { name: 'Priya Sharma',    phone: '9876543210', email: 'priya.s@gmail.com',   city: 'Bengaluru', channel: 'whatsapp', opted_in_whatsapp: true  },
      { name: 'Rahul Menon',     phone: '8765432109', email: 'rahul.m@gmail.com',   city: 'Bengaluru', channel: 'sms',      opted_in_sms: true       },
      { name: 'Sunita Rao',      phone: '7654321098', email: 'sunita.r@gmail.com',  city: 'Bengaluru', channel: 'whatsapp', opted_in_whatsapp: true  },
      { name: 'Vikram Nair',     phone: '6543210987', email: 'vikram.n@gmail.com',  city: 'Mysuru',    channel: 'email',    opted_in_email: true     },
      { name: 'Anita Desai',     phone: '9543210987', email: 'anita.d@gmail.com',   city: 'Bengaluru', channel: 'whatsapp', opted_in_whatsapp: true  },
      { name: 'Meera Pillai',    phone: '8432109876', email: 'meera.p@gmail.com',   city: 'Bengaluru', channel: 'whatsapp', opted_in_whatsapp: true  },
      { name: 'Rajesh Kumar',    phone: '7321098765', email: 'rajesh.k@gmail.com',  city: 'Bengaluru', channel: 'sms',      opted_in_sms: true       },
      { name: 'Deepa Krishnan',  phone: '6210987654', email: 'deepa.k@gmail.com',   city: 'Mangaluru', channel: 'whatsapp', opted_in_whatsapp: true  },
    ];

    const vetCustIds = [];
    for (const c of vetCustomers) {
      const lv = new Date(); lv.setMonth(lv.getMonth() - Math.floor(Math.random() * 8));
      const { rows } = await client.query(`
        INSERT INTO customers
          (business_id, name, phone, email, city, preferred_channel,
           opted_in_sms, opted_in_whatsapp, opted_in_email,
           opted_in_at, last_visit_at, status, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,'active','manual')
        ON CONFLICT (business_id, phone) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [bizIds[0], c.name, c.phone, c.email, c.city, c.channel,
          c.opted_in_sms || false, c.opted_in_whatsapp || false, c.opted_in_email || false,
          lv]);
      vetCustIds.push(rows[0].id);
    }
    console.log('  Vet customers created');

    // ─── Pets (entities) for vet customers ────────────────────────
    const petData = [
      { i: 0, name: 'Luna',    type: 'dog',  breed: 'Labrador',         dob: '2021-03-15' },
      { i: 1, name: 'Milo',    type: 'cat',  breed: 'Persian',          dob: '2020-07-01' },
      { i: 2, name: 'Bruno',   type: 'dog',  breed: 'Beagle',           dob: '2019-11-20' },
      { i: 3, name: 'Tiger',   type: 'dog',  breed: 'German Shepherd',  dob: '2018-05-10' },
      { i: 4, name: 'Coco',    type: 'dog',  breed: 'Cocker Spaniel',   dob: '2022-01-08' },
      { i: 5, name: 'Whisper', type: 'cat',  breed: 'Indie Cat',        dob: '2021-09-14' },
      { i: 6, name: 'Max',     type: 'dog',  breed: 'Labrador',         dob: '2023-02-01' },
      { i: 7, name: 'Buddy',   type: 'dog',  breed: 'Golden Retriever', dob: '2019-06-25' },
    ];

    const petIds = [];
    for (const p of petData) {
      const { rows } = await client.query(`
        INSERT INTO customer_entities
          (customer_id, business_id, name, entity_type, breed_or_model, dob_or_year)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
      `, [vetCustIds[p.i], bizIds[0], p.name, p.type, p.breed, p.dob]);
      petIds.push(rows[0].id);
    }
    console.log('  Pets created');

    // ─── Service events for vet ────────────────────────────────────
    const vetEvents = [
      { ci: 0, ei: 0, type: 'Annual Vaccination', cat: 'vaccination', days_ago: 20,  fu_days: 365, amount: 1200 },
      { ci: 1, ei: 1, type: 'Grooming',            cat: 'grooming',    days_ago: 18,  fu_days: 21,  amount: 450  },
      { ci: 2, ei: 2, type: 'Deworming',           cat: 'deworming',   days_ago: 95,  fu_days: 90,  amount: 300  },
      { ci: 3, ei: 3, type: 'Annual Checkup',      cat: 'checkup',     days_ago: 245, fu_days: 365, amount: 650  },
      { ci: 4, ei: 4, type: 'Grooming',            cat: 'grooming',    days_ago: 5,   fu_days: 21,  amount: 450  },
      { ci: 5, ei: 5, type: 'Annual Checkup',      cat: 'checkup',     days_ago: 1,   fu_days: 365, amount: 650  },
      { ci: 6, ei: 6, type: 'Booster Shot',        cat: 'vaccination', days_ago: 0,   fu_days: 180, amount: 800  },
      { ci: 7, ei: 7, type: 'Annual Vaccination',  cat: 'vaccination', days_ago: 199, fu_days: 365, amount: 1200 },
    ];

    for (const ev of vetEvents) {
      const evDate = new Date();
      evDate.setDate(evDate.getDate() - ev.days_ago);
      await client.query(`
        INSERT INTO service_events
          (business_id, customer_id, entity_id, service_type, service_category,
           event_date, status, follow_up_days, amount_charged, amount_paid,
           payment_method, staff_name)
        VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$8,'upi','Dr. Priya Sharma')
      `, [bizIds[0], vetCustIds[ev.ci], petIds[ev.ei], ev.type, ev.cat,
          evDate.toISOString().split('T')[0], ev.fu_days, ev.amount]);
    }
    console.log('  Vet service events created');

    // ─── Reminder templates — Vet ──────────────────────────────────
    const vetTemplates = [
      {
        name: 'Annual Vaccination Reminder',
        service_category: 'vaccination', remind_after_days: 350,
        whatsapp_template: 'Namaste {customer_name}, {pet_name} ki annual vaccination ka samay aa raha hai. {business_name} mein appointment book karein.',
        sms_template: 'Dear {customer_name}, {pet_name}\'s annual vaccination is due on {due_date}. Call {business_name} to book: reply BOOK',
        email_subject: '{pet_name}\'s Annual Vaccination Due — {business_name}',
        email_body: 'Dear {customer_name},\n\nThis is a reminder that {pet_name}\'s annual vaccination is due on {due_date}.\n\nPlease call us to schedule an appointment.\n\nRegards,\n{business_name}',
        followup_after_days: 7,
      },
      {
        name: 'Grooming Cycle Reminder',
        service_category: 'grooming', remind_after_days: 18,
        whatsapp_template: 'Hi {customer_name}! {pet_name} ki grooming appointment book karein — {business_name}.',
        sms_template: 'Hi {customer_name}, time to book {pet_name}\'s grooming at {business_name}. Reply BOOK.',
        email_subject: 'Time for {pet_name}\'s Grooming — {business_name}',
        email_body: 'Dear {customer_name},\n\nIt\'s been a few weeks since {pet_name}\'s last grooming session.\n\nBook an appointment with us today.\n\nRegards,\n{business_name}',
      },
      {
        name: 'Deworming Reminder',
        service_category: 'deworming', remind_after_days: 85,
        whatsapp_template: 'Namaste {customer_name}! {pet_name} ke deworming ka samay ho gaya hai. {business_name} se sampark karein.',
        sms_template: 'Dear {customer_name}, {pet_name}\'s deworming is due. Book at {business_name}.',
        email_subject: '{pet_name} — Deworming Due | {business_name}',
        email_body: 'Dear {customer_name},\n\n{pet_name}\'s quarterly deworming is due.\n\nRegards,\n{business_name}',
      },
    ];

    for (const t of vetTemplates) {
      await client.query(`
        INSERT INTO reminder_templates
          (business_id, name, service_category, remind_after_days,
           whatsapp_template, sms_template, email_subject, email_body, followup_after_days)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [bizIds[0], t.name, t.service_category, t.remind_after_days,
          t.whatsapp_template, t.sms_template, t.email_subject, t.email_body,
          t.followup_after_days || null]);
    }
    console.log('  Vet reminder templates created');

    // ─── Sample scheduled reminders ───────────────────────────────
    const remindersData = [
      { ci: 2, type: 'Deworming',           ch: 'whatsapp', daysFromNow: -21 },  // overdue
      { ci: 3, type: 'Annual Checkup',      ch: 'email',    daysFromNow: -64 },  // overdue
      { ci: 7, type: 'Annual Vaccination',  ch: 'whatsapp', daysFromNow: -19 },  // overdue
      { ci: 0, type: 'Annual Vaccination',  ch: 'whatsapp', daysFromNow:  0  },  // today
      { ci: 1, type: 'Grooming',            ch: 'sms',      daysFromNow:  1  },  // tomorrow
      { ci: 4, type: 'Grooming',            ch: 'whatsapp', daysFromNow:  16 },  // upcoming
      { ci: 5, type: 'Annual Checkup',      ch: 'whatsapp', daysFromNow:  364 }, // upcoming
      { ci: 6, type: 'Booster Shot',        ch: 'sms',      daysFromNow:  179 }, // upcoming
    ];

    for (const r of remindersData) {
      const scheduledAt = new Date();
      scheduledAt.setDate(scheduledAt.getDate() + r.daysFromNow);
      await client.query(`
        INSERT INTO reminders
          (business_id, customer_id, entity_id, reminder_type, channel, scheduled_at, status)
        VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
      `, [bizIds[0], vetCustIds[r.ci], petIds[r.ci], r.type, r.ch, scheduledAt]);
    }
    console.log('  Reminders created');

    await client.query('COMMIT');
    console.log('\nSeed complete. Demo credentials:');
    console.log('  Email:    priya@pawcare.in');
    console.log('  Password: ShihFu@2024');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => { console.error(err); process.exit(1); });
