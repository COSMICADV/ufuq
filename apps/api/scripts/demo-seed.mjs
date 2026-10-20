/**
 * Staging demo company — "Al-Nour Trading & Distribution".
 *
 * NOT reference data and never run in production. It seeds one realistic
 * tenant that looks like it has been using Ufuq since the summer:
 *
 *   1. Identity rows the public API cannot create without email (the company,
 *      its ADMIN, and employee passwords) go straight to the database as the
 *      migration/owner role, through `withTenant` like every other write.
 *   2. Everything with business rules — structure, employees, salaries,
 *      leave, requests, tasks, goals, inventory, payroll, monthly reports —
 *      goes through the running API, so validation, ledgers, payroll maths,
 *      audit logs and in-app notifications are produced by the product itself.
 *   3. Attendance history before today (which the API only records "now")
 *      is backfilled with the API's own `calculateDay`, so every status and
 *      minute count is exactly what the product would have computed.
 *
 * Idempotent at the company level: if the demo company already has
 * employees, it exits without writing anything.
 *
 * Usage (from apps/api, after `pnpm build`, with the API running):
 *   DATABASE_MIGRATION_URL=… DEMO_API_URL=http://127.0.0.1:$PORT node scripts/demo-seed.mjs
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { hashPassword } from '@ufuq/auth';
import { createPrismaClient, generateId, withTenant } from '@ufuq/db';

import { calculateDay } from '../dist/attendance/calculation.js';
import {
  dayOfWeek,
  eachDay,
  formatCalendarDate,
  instantAt,
} from '../dist/attendance/zoned-time.js';

const COMPANY_ID = '00000000-0000-7000-8000-00000000a1a1';
const COMPANY_SLUG = 'al-nour-trading';
const TIMEZONE = 'Africa/Cairo';

// Demo credentials requested for the staging walkthrough — staging only.
const ADMIN = {
  email: 'admin.kadry@demo.ufuq.local',
  password: '123456789',
  displayName: 'Admin Kadry',
};
const AHMED_PASSWORD = '234567890';

const API = (process.env.DEMO_API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** Deterministic PRNG so a reseed of an empty database produces the same story. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayInCairo() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24 };
}

function addDays(date, days) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function monthStart(date, offset) {
  const d = new Date(Date.UTC(date.year, date.month - 1 + offset, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 };
}

function monthEnd(date, offset) {
  const d = new Date(Date.UTC(date.year, date.month + offset, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const iso = formatCalendarDate;
const dbDate = (date) => new Date(`${iso(date)}T00:00:00.000Z`);

/** Next working day (Sun–Thu) on or after `date`, `n` working days ahead. */
function workingDayFrom(date, n) {
  let cursor = date;
  let remaining = n;
  for (;;) {
    const dow = dayOfWeek(cursor);
    if (dow !== 5 && dow !== 6) {
      if (remaining === 0) return cursor;
      remaining -= 1;
    }
    cursor = addDays(cursor, 1);
  }
}

class ApiFailure extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

// Each demo actor appears from its own TEST-NET-2 address (RFC 5737), so the
// per-IP login limit treats them as the separate people they are. Only
// honoured when the API runs with TRUST_PROXY_HOPS.
const actorAddress = new Map();
function addressFor(key) {
  if (!actorAddress.has(key)) actorAddress.set(key, `198.51.100.${10 + actorAddress.size}`);
  return actorAddress.get(key);
}

async function api(token, method, path, body, actor) {
  const headers = { 'Accept-Language': 'en', 'X-Client-Type': 'mobile' };
  headers['X-Forwarded-For'] = addressFor(actor ?? token ?? 'anonymous');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(`${API}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiFailure(method, path, response.status, parsed);
  return parsed?.data;
}

/** As the person themselves; as ADMIN where their role cannot reach the record. */
async function asOrAdmin(token, admin, method, path, body) {
  try {
    return await api(token, method, path, body);
  } catch (error) {
    if (error instanceof ApiFailure && (error.status === 403 || error.status === 404)) {
      return api(admin, method, path, body);
    }
    throw error;
  }
}

/** Optional storytelling steps: log and carry on rather than abort the seed. */
async function soft(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.warn(`  ! skipped ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function login(email, password) {
  const data = await api(null, 'POST', '/auth/login', { email, password }, email);
  return data.accessToken;
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

const DEPARTMENTS = [
  { key: 'mgmt', name_ar: 'الإدارة العامة', name_en: 'General Management' },
  { key: 'sales', name_ar: 'المبيعات', name_en: 'Sales' },
  { key: 'ops', name_ar: 'المستودعات والخدمات اللوجستية', name_en: 'Warehouse & Logistics' },
  { key: 'finance', name_ar: 'المالية والمحاسبة', name_en: 'Finance & Accounting' },
  { key: 'hr', name_ar: 'الموارد البشرية', name_en: 'Human Resources' },
];

const POSITIONS = [
  { key: 'salesManager', dept: 'sales', title_ar: 'مدير المبيعات', title_en: 'Sales Manager' },
  { key: 'salesExec', dept: 'sales', title_ar: 'أخصائي مبيعات', title_en: 'Sales Executive' },
  { key: 'salesRep', dept: 'sales', title_ar: 'مندوب مبيعات', title_en: 'Sales Representative' },
  {
    key: 'whSupervisor',
    dept: 'ops',
    title_ar: 'مشرف المستودعات',
    title_en: 'Warehouse Supervisor',
  },
  { key: 'storekeeper', dept: 'ops', title_ar: 'أمين مخزن', title_en: 'Storekeeper' },
  { key: 'accountant', dept: 'finance', title_ar: 'محاسب', title_en: 'Accountant' },
  { key: 'hrSpecialist', dept: 'hr', title_ar: 'أخصائي موارد بشرية', title_en: 'HR Specialist' },
];

// Attendance personalities: lateness / WFH / absence probabilities per working day.
const EMPLOYEES = [
  {
    key: 'mona',
    first_name: 'Mona',
    last_name: 'Abdelrahman',
    email: 'mona.abdelrahman@demo.ufuq.local',
    phone: '+20 100 245 7781',
    code: 'NT-1001',
    dept: 'sales',
    position: 'salesManager',
    role: 'manager',
    joining: '2023-02-12',
    salary: '32000.00',
    profile: { late: 0.05, wfh: 0.15, absent: 0.0, overtime: 0.4 },
  },
  {
    key: 'omar',
    first_name: 'Omar',
    last_name: 'Farouk',
    email: 'omar.farouk@demo.ufuq.local',
    phone: '+20 111 830 4402',
    code: 'NT-1002',
    dept: 'ops',
    position: 'whSupervisor',
    role: 'manager',
    joining: '2022-09-04',
    salary: '24000.00',
    profile: { late: 0.06, wfh: 0.0, absent: 0.01, overtime: 0.35 },
  },
  {
    key: 'ahmed',
    first_name: 'Ahmed',
    last_name: 'Hassan',
    displayName: 'Ahmed',
    email: 'ahmed@demo.ufuq.local',
    phone: '+20 102 667 1930',
    code: 'NT-1003',
    dept: 'sales',
    position: 'salesExec',
    role: 'employee',
    manager: 'mona',
    joining: '2024-03-17',
    salary: '18000.00',
    profile: { late: 0.12, wfh: 0.2, absent: 0.0, overtime: 0.25 },
  },
  {
    key: 'khaled',
    first_name: 'Khaled',
    last_name: 'Mostafa',
    email: 'khaled.mostafa@demo.ufuq.local',
    phone: '+20 109 412 5568',
    code: 'NT-1004',
    dept: 'sales',
    position: 'salesRep',
    role: 'employee',
    manager: 'mona',
    joining: '2025-01-05',
    salary: '14500.00',
    profile: { late: 0.18, wfh: 0.25, absent: 0.02, overtime: 0.1 },
  },
  {
    key: 'youssef',
    first_name: 'Youssef',
    last_name: 'Adel',
    email: 'youssef.adel@demo.ufuq.local',
    phone: '+20 122 908 3317',
    code: 'NT-1005',
    dept: 'ops',
    position: 'storekeeper',
    role: 'employee',
    manager: 'omar',
    joining: '2024-07-21',
    salary: '11500.00',
    profile: { late: 0.1, wfh: 0.0, absent: 0.03, overtime: 0.3 },
  },
  {
    key: 'sara',
    first_name: 'Sara',
    last_name: 'Mahmoud',
    email: 'sara.mahmoud@demo.ufuq.local',
    phone: '+20 127 554 0846',
    code: 'NT-1006',
    dept: 'finance',
    position: 'accountant',
    role: 'employee',
    joining: '2023-11-01',
    salary: '21000.00',
    profile: { late: 0.04, wfh: 0.3, absent: 0.0, overtime: 0.2 },
  },
  {
    key: 'nour',
    first_name: 'Nour',
    last_name: 'El-Sayed',
    email: 'nour.elsayed@demo.ufuq.local',
    phone: '+20 106 731 2295',
    code: 'NT-1007',
    dept: 'hr',
    position: 'hrSpecialist',
    role: 'employee',
    joining: '2024-10-13',
    salary: '17000.00',
    profile: { late: 0.07, wfh: 0.2, absent: 0.01, overtime: 0.1 },
  },
];

// ---------------------------------------------------------------------------
// Stage 1 — company and ADMIN (database)
// ---------------------------------------------------------------------------

async function seedCompanyAndAdmin(prisma) {
  return withTenant(prisma, COMPANY_ID, async (tx) => {
    const existing = await tx.company.findUnique({ where: { id: COMPANY_ID } });
    if (existing) {
      const employees = await tx.employee.count();
      if (employees > 0) return { alreadySeeded: true };
    } else {
      await tx.company.create({
        data: {
          id: COMPANY_ID,
          name: 'شركة النور للتجارة والتوزيع',
          slug: COMPANY_SLUG,
          timezone: TIMEZONE,
          currency: 'EGP',
          defaultLocale: 'ar',
          employeeCountRange: '1-10',
        },
      });
    }
    const adminRole = await tx.role.findFirstOrThrow({ where: { companyId: null, key: 'admin' } });
    const passwordHash = await hashPassword(ADMIN.password);
    const admin = await tx.user.upsert({
      where: { companyId_email: { companyId: COMPANY_ID, email: ADMIN.email } },
      create: {
        id: generateId(),
        companyId: COMPANY_ID,
        email: ADMIN.email,
        displayName: ADMIN.displayName,
        phone: '+20 100 000 4521',
        passwordHash,
        roleId: adminRole.id,
        status: 'active',
        locale: 'ar',
        emailVerifiedAt: new Date(),
      },
      update: { passwordHash, status: 'active', displayName: ADMIN.displayName },
    });
    await tx.company.update({ where: { id: COMPANY_ID }, data: { createdBy: admin.id } });
    return { alreadySeeded: false, adminUserId: admin.id };
  });
}

// ---------------------------------------------------------------------------
// Stage 2 — structure and people (API), then passwords (database)
// ---------------------------------------------------------------------------

async function seedStructure(admin, today) {
  await api(admin, 'PATCH', '/company', {
    name: 'شركة النور للتجارة والتوزيع',
    correction_window_days: 14,
  });

  const days = [0, 1, 2, 3, 4, 5, 6].map((day_of_week) =>
    day_of_week === 5 || day_of_week === 6
      ? { day_of_week, is_working_day: false, start_time: null, end_time: null }
      : { day_of_week, is_working_day: true, start_time: '09:00', end_time: '17:00' },
  );
  const schedule = await api(admin, 'POST', '/work-schedules', {
    name: 'Head office — Sun to Thu, 9:00–17:00',
    is_default: true,
    timezone: TIMEZONE,
    grace_period_minutes: 15,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    break_minutes: 60,
    days,
  });

  const holidays = [
    { date: `${today.year}-01-07`, name_ar: 'عيد الميلاد المجيد', name_en: 'Coptic Christmas' },
    { date: `${today.year}-04-25`, name_ar: 'عيد تحرير سيناء', name_en: 'Sinai Liberation Day' },
    { date: `${today.year}-07-23`, name_ar: 'عيد ثورة 23 يوليو', name_en: 'Revolution Day' },
    { date: `${today.year}-08-26`, name_ar: 'المولد النبوي الشريف', name_en: "Prophet's Birthday" },
    { date: `${today.year}-10-06`, name_ar: 'عيد القوات المسلحة', name_en: 'Armed Forces Day' },
  ];
  for (const holiday of holidays) {
    await api(admin, 'POST', '/holidays', { ...holiday, is_recurring: false });
  }

  const departments = {};
  for (const { key, ...dto } of DEPARTMENTS) {
    departments[key] = (await api(admin, 'POST', '/departments', dto)).id;
  }
  const positions = {};
  for (const { key, dept, ...dto } of POSITIONS) {
    positions[key] = (
      await api(admin, 'POST', '/positions', { ...dto, department_id: departments[dept] })
    ).id;
  }
  return { scheduleId: schedule.id, departments, positions, holidays };
}

async function seedEmployees(admin, structure) {
  const ids = {};
  for (const employee of EMPLOYEES) {
    const created = await api(admin, 'POST', '/employees', {
      first_name: employee.first_name,
      last_name: employee.last_name,
      email: employee.email,
      phone: employee.phone,
      employee_code: employee.code,
      department_id: structure.departments[employee.dept],
      position_id: structure.positions[employee.position],
      manager_id: employee.manager ? ids[employee.manager] : null,
      work_schedule_id: structure.scheduleId,
      joining_date: employee.joining,
      role_key: employee.role,
      send_invitation: false,
    });
    ids[employee.key] = created.id;
  }
  await api(admin, 'PATCH', `/departments/${structure.departments.sales}`, {
    manager_employee_id: ids.mona,
  });
  await api(admin, 'PATCH', `/departments/${structure.departments.ops}`, {
    manager_employee_id: ids.omar,
  });
  return ids;
}

/**
 * The product activates an employee account through an emailed invitation.
 * Staging has no mailbox, so the demo activates the accounts directly: Ahmed
 * gets the requested demo password; the other six get random passwords that
 * are never printed — they exist only so this script can act as them.
 */
async function activateAccounts(prisma) {
  const passwords = {};
  await withTenant(prisma, COMPANY_ID, async (tx) => {
    for (const employee of EMPLOYEES) {
      const password =
        employee.key === 'ahmed' ? AHMED_PASSWORD : randomBytes(18).toString('base64url');
      passwords[employee.key] = password;
      await tx.user.update({
        where: { companyId_email: { companyId: COMPANY_ID, email: employee.email } },
        data: {
          passwordHash: await hashPassword(password),
          status: 'active',
          emailVerifiedAt: new Date(),
          displayName: employee.displayName ?? `${employee.first_name} ${employee.last_name}`,
          locale: 'ar',
        },
      });
      await tx.invitation.updateMany({
        where: { user: { email: employee.email } },
        data: { acceptedAt: new Date() },
      });
    }
  });
  const tokens = {};
  for (const employee of EMPLOYEES) {
    tokens[employee.key] = await login(employee.email, passwords[employee.key]);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Stage 3 — payroll setup, leave (API)
// ---------------------------------------------------------------------------

async function seedSalaries(admin, ids) {
  await api(admin, 'PATCH', '/salary-policies', {
    name: 'Standard monthly policy',
    daily_wage_basis: 'scheduled_working_days',
    unpaid_leave_deduction: 'daily_wage',
    absence_deduction: 'daily_wage',
    lateness_rule: { type: 'per_minute', multiplier: '1.00' },
    overtime_rate: '1.35',
    rounding: 'nearest',
  });
  for (const employee of EMPLOYEES) {
    const joining = employee.joining;
    const from = joining > '2026-01-01' ? joining : '2026-01-01';
    await api(admin, 'POST', `/employees/${ids[employee.key]}/salary`, {
      monthly_salary: employee.salary,
      effective_from: from,
      note: 'Annual salary review 2026',
    });
  }
}

async function seedLeaveTypes(admin) {
  const types = {};
  const definitions = [
    {
      key: 'annual',
      name_ar: 'إجازة سنوية',
      name_en: 'Annual leave',
      is_paid: true,
      default_days_per_year: '21.00',
      requires_attachment: false,
      allows_negative_balance: false,
      carry_over_policy: 'capped',
      carry_over_cap: '5.00',
    },
    {
      key: 'sick',
      name_ar: 'إجازة مرضية',
      name_en: 'Sick leave',
      is_paid: true,
      default_days_per_year: '15.00',
      requires_attachment: false,
      allows_negative_balance: false,
      carry_over_policy: 'none',
    },
    {
      key: 'casual',
      name_ar: 'إجازة عارضة',
      name_en: 'Casual leave',
      is_paid: true,
      default_days_per_year: '6.00',
      requires_attachment: false,
      allows_negative_balance: false,
      carry_over_policy: 'none',
    },
    {
      key: 'unpaid',
      name_ar: 'إجازة بدون أجر',
      name_en: 'Unpaid leave',
      is_paid: false,
      default_days_per_year: '30.00',
      requires_attachment: false,
      allows_negative_balance: false,
      carry_over_policy: 'none',
    },
  ];
  // A new company starts with zero-day placeholder types; the demo's
  // configured types replace them, so retire the placeholders.
  const placeholders = await api(admin, 'GET', '/leave-types');
  for (const { key, ...dto } of definitions) {
    types[key] = (await api(admin, 'POST', '/leave-types', dto)).id;
  }
  for (const placeholder of placeholders ?? []) {
    await soft(`retire leave type ${placeholder.name_en}`, () =>
      api(admin, 'DELETE', `/leave-types/${placeholder.id}`),
    );
  }
  return types;
}

async function seedLeave(admin, tokens, types, today) {
  const lastMonth = monthStart(today, -1);
  const twoMonthsAgo = monthStart(today, -2);
  const plans = [
    // Approved, in the past: these become on_leave attendance days.
    {
      who: 'ahmed',
      type: 'annual',
      start: workingDayFrom(addDays(twoMonthsAgo, 10), 0),
      days: 2,
      reason: 'Family wedding in Mansoura',
      decision: 'approve',
    },
    {
      who: 'ahmed',
      type: 'sick',
      start: workingDayFrom(addDays(lastMonth, 15), 0),
      days: 1,
      reason: 'Flu — doctor advised rest',
      decision: 'approve',
    },
    {
      who: 'mona',
      type: 'annual',
      start: workingDayFrom(addDays(lastMonth, 6), 0),
      days: 4,
      reason: 'Summer vacation in Dahab',
      decision: 'approve',
    },
    {
      who: 'youssef',
      type: 'casual',
      start: workingDayFrom(addDays(monthStart(today, 0), 1), 0),
      days: 1,
      reason: 'Personal errand at the traffic department',
      decision: 'approve',
    },
    {
      who: 'sara',
      type: 'unpaid',
      start: workingDayFrom(addDays(twoMonthsAgo, 18), 0),
      days: 1,
      reason: 'Extra day after annual balance planning',
      decision: 'approve',
    },
    // Upcoming.
    {
      who: 'sara',
      type: 'annual',
      start: workingDayFrom(addDays(today, 9), 0),
      days: 2,
      reason: 'Long weekend with family',
      decision: 'approve',
    },
    {
      who: 'ahmed',
      type: 'annual',
      start: workingDayFrom(addDays(today, 14), 0),
      days: 3,
      reason: 'Planned trip to Aswan',
      decision: null,
    },
    {
      who: 'khaled',
      type: 'annual',
      start: workingDayFrom(addDays(today, 5), 0),
      days: 2,
      reason: 'Moving to a new apartment',
      decision: null,
    },
    {
      who: 'nour',
      type: 'casual',
      start: workingDayFrom(addDays(today, 3), 0),
      days: 1,
      reason: 'Medical appointment',
      decision: null,
    },
    {
      who: 'youssef',
      type: 'annual',
      start: workingDayFrom(addDays(today, 2), 0),
      days: 3,
      reason: 'Visiting family in Sohag',
      decision: 'reject',
    },
  ];
  const leaveDays = new Map(); // `${who}|${date}` → true
  for (const plan of plans) {
    const end = workingDayFrom(plan.start, plan.days - 1);
    const created = await soft(`leave ${plan.who} ${iso(plan.start)}`, () =>
      api(tokens[plan.who], 'POST', '/leave-requests', {
        leave_type_id: types[plan.type],
        start_date: iso(plan.start),
        end_date: iso(end),
        reason: plan.reason,
      }),
    );
    if (!created) continue;
    if (plan.decision === 'approve') {
      const approved = await soft('approve leave', () =>
        api(admin, 'POST', `/leave-requests/${created.id}/approve`, {
          review_note: 'Approved — enjoy your time off.',
        }),
      );
      if (approved) {
        for (const day of eachDay(plan.start, end)) leaveDays.set(`${plan.who}|${iso(day)}`, true);
      }
    } else if (plan.decision === 'reject') {
      await soft('reject leave', () =>
        api(admin, 'POST', `/leave-requests/${created.id}/reject`, {
          review_note: 'Month-end stock count that week — please pick the following week.',
        }),
      );
    }
  }
  return leaveDays;
}

// ---------------------------------------------------------------------------
// Stage 4 — attendance history (database, using the API's own calculation)
// ---------------------------------------------------------------------------

const SCHEDULE_SETTINGS = {
  timezone: TIMEZONE,
  gracePeriodMinutes: 15,
  breakMinutes: 60,
  halfDayThresholdHours: 4,
  overtimePolicy: 'paid',
};
const WORKING_DAY = { isWorkingDay: true, startMinutes: 9 * 60, endMinutes: 17 * 60 };
const OFF_DAY = { isWorkingDay: false, startMinutes: null, endMinutes: null };

async function seedAttendance(prisma, today, holidays, leaveDays) {
  const holidaySet = new Set(holidays.map((h) => h.date));
  const from = monthStart(today, -2);
  const yesterday = addDays(today, -1);
  const rand = prng(20261020);
  let written = 0;

  await withTenant(prisma, COMPANY_ID, async (tx) => {
    const employees = await tx.employee.findMany({
      select: { id: true, email: true, userId: true, joiningDate: true },
    });
    const systemActor = await tx.user.findFirst({ where: { isSystem: true } });
    const existing = await tx.attendanceRecord.findMany({
      select: { id: true, employeeId: true, date: true, source: true, status: true },
    });
    const existingByKey = new Map(
      existing.map((r) => [`${r.employeeId}|${iso(fromDb(r.date))}`, r]),
    );

    for (const spec of EMPLOYEES) {
      const employee = employees.find((e) => e.email === spec.email);
      const { profile } = spec;
      const days = eachDay(from, yesterday);
      // Today, if the working day is under way: everyone except Ahmed is in,
      // so Ahmed can demonstrate check-in himself.
      if (today.hour >= 10 && dayOfWeek(today) !== 5 && dayOfWeek(today) !== 6) days.push(today);

      for (const date of days) {
        const key = `${employee.id}|${iso(date)}`;
        const prior = existingByKey.get(key);
        // Leave approval already wrote this day; never overwrite it.
        if (prior && prior.source !== 'system') continue;
        if (prior && prior.status === 'on_leave') continue;
        if (leaveDays.has(`${spec.key}|${iso(date)}`)) continue;

        const isToday = iso(date) === iso(today);
        if (isToday && spec.key === 'ahmed') continue;

        const dow = dayOfWeek(date);
        const isHoliday = holidaySet.has(iso(date));
        const working = dow !== 5 && dow !== 6;
        const day = working ? WORKING_DAY : OFF_DAY;

        let checkInAt = null;
        let checkOutAt = null;
        let workMode = null;
        if (working && !isHoliday && rand() >= profile.absent) {
          const late = rand() < profile.late;
          const inMinute = late
            ? 9 * 60 + 20 + Math.floor(rand() * 50)
            : 8 * 60 + 35 + Math.floor(rand() * 35);
          const halfDay = rand() < 0.015;
          const overtime = rand() < profile.overtime;
          const outMinute = halfDay
            ? 12 * 60 + Math.floor(rand() * 30)
            : overtime
              ? 17 * 60 + 30 + Math.floor(rand() * 90)
              : 17 * 60 + Math.floor(rand() * 25);
          workMode = rand() < profile.wfh ? 'wfh' : 'office';
          checkInAt = instantAt(date, inMinute, TIMEZONE);
          checkOutAt = isToday ? null : instantAt(date, outMinute, TIMEZONE);
        }
        const calc = calculateDay({
          date,
          schedule: SCHEDULE_SETTINGS,
          day,
          checkInAt,
          checkOutAt,
          isHoliday,
        });
        const selfRecorded = checkInAt !== null;
        const data = {
          workMode,
          checkInAt,
          checkOutAt,
          workingMinutes: calc.workingMinutes,
          overtimeMinutes: calc.overtimeMinutes,
          lateMinutes: calc.lateMinutes,
          status: calc.status,
          source: selfRecorded ? 'self' : 'system',
          createdBy: selfRecorded ? employee.userId : (systemActor?.id ?? null),
        };
        if (prior) {
          await tx.attendanceRecord.update({ where: { id: prior.id }, data });
        } else {
          await tx.attendanceRecord.create({
            data: {
              id: generateId(),
              companyId: COMPANY_ID,
              employeeId: employee.id,
              date: dbDate(date),
              ...data,
            },
          });
        }
        written += 1;
      }
    }
  });
  return written;
}

function fromDb(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Stage 5 — requests, corrections, tasks, goals (API)
// ---------------------------------------------------------------------------

async function seedTasksAndGoals(admin, tokens, ids, structure, today) {
  const d = (n) => iso(addDays(today, n));
  const periodStart = iso(monthStart(today, 0));
  const periodEnd = iso(monthEnd(today, 0));
  const quarterEnd = iso(monthEnd(today, 2 - ((today.month - 1) % 3)));

  const goals = {};
  const goalPlans = [
    {
      key: 'ahmedSales',
      who: 'ahmed',
      type: 'sales',
      title: 'October sales target — corporate accounts',
      target_value: '250000.00',
      unit: 'EGP',
      progress: [
        ['62000.00', 'Delta Pharma office-supply contract signed'],
        ['118500.00', 'Two repeat orders from Cairo Logistics'],
        ['168500.00', 'Nile Clinics printer bundle delivered'],
      ],
    },
    {
      key: 'ahmedAccounts',
      who: 'ahmed',
      type: 'custom',
      title: 'Win 4 new corporate accounts',
      target_value: '4.00',
      unit: 'accounts',
      progress: [['3.00', 'Third account onboarded: Horizon Schools']],
    },
    {
      key: 'khaledSales',
      who: 'khaled',
      type: 'sales',
      title: 'October sales target — SMB accounts',
      target_value: '180000.00',
      unit: 'EGP',
      progress: [
        ['41000.00', 'Nasr City retail cluster'],
        ['92000.00', 'Heliopolis cafés and offices'],
      ],
    },
    {
      key: 'monaTeam',
      who: 'mona',
      type: 'sales',
      title: 'Q4 team revenue',
      target_value: '1500000.00',
      unit: 'EGP',
      period_end: quarterEnd,
      progress: [['410000.00', 'October to date, whole team']],
    },
    {
      key: 'omarAccuracy',
      who: 'omar',
      type: 'custom',
      title: 'Stock-count accuracy of 98% or better',
      target_value: '98.00',
      unit: '%',
      progress: [['96.50', 'Last cycle count — Main warehouse']],
    },
    {
      key: 'youssefShipments',
      who: 'youssef',
      type: 'custom',
      title: 'Process 120 inbound shipments',
      target_value: '120.00',
      unit: 'shipments',
      progress: [['74.00', 'Weekly receiving log']],
    },
    {
      key: 'saraClose',
      who: 'sara',
      type: 'custom',
      title: 'Reconcile all supplier statements',
      target_value: '12.00',
      unit: 'suppliers',
      progress: [['9.00', 'Remaining: three regional suppliers']],
    },
    {
      key: 'nourPolicies',
      who: 'nour',
      type: 'custom',
      title: 'Publish 3 updated HR policies',
      target_value: '3.00',
      unit: 'policies',
      progress: [['1.00', 'Remote-work policy published']],
    },
  ];
  for (const plan of goalPlans) {
    const goal = await soft(`goal ${plan.title}`, () =>
      api(admin, 'POST', '/goals', {
        employee_id: ids[plan.who],
        type: plan.type,
        title: plan.title,
        target_value: plan.target_value,
        unit: plan.unit,
        period_start: periodStart,
        period_end: plan.period_end ?? periodEnd,
      }),
    );
    if (!goal) continue;
    goals[plan.key] = goal.id;
    for (const [value, note] of plan.progress) {
      await soft('goal progress', () =>
        api(tokens[plan.who], 'POST', `/goals/${goal.id}/progress`, { value, note }).catch(() =>
          api(admin, 'POST', `/goals/${goal.id}/progress`, { value, note }),
        ),
      );
    }
  }

  const sales = structure.departments.sales;
  const ops = structure.departments.ops;
  const finance = structure.departments.finance;
  const hr = structure.departments.hr;
  const taskPlans = [
    {
      who: 'ahmed',
      dept: sales,
      title: 'Follow up Q4 quotation with Delta Pharma',
      description: 'Confirm quantities for toner and A4 paper, and send the revised quotation.',
      priority: 'high',
      start: d(-6),
      deadline: d(4),
      goal: 'ahmedSales',
      checklist: ['Call procurement manager', 'Revise quotation', 'Send samples', 'Get PO number'],
      done: 2,
      status: 'in_progress',
      notes: ['Procurement asked for a 5% volume discount — checking with Mona.'],
    },
    {
      who: 'ahmed',
      dept: sales,
      title: 'Prepare monthly sales report',
      description: 'Summarise last month’s orders per account for the sales meeting.',
      priority: 'medium',
      start: d(-18),
      deadline: d(-12),
      checklist: ['Export orders', 'Build the summary', 'Share with Mona'],
      done: 3,
      status: 'completed',
    },
    {
      who: 'ahmed',
      dept: sales,
      title: 'Update CRM contacts for new accounts',
      priority: 'low',
      start: d(-9),
      deadline: d(-2),
      checklist: ['Horizon Schools', 'Nile Clinics', 'Cairo Logistics'],
      done: 1,
      status: 'in_progress',
    },
    {
      who: 'ahmed',
      dept: sales,
      title: 'Visit Alexandria branch clients',
      description: 'Two visits with the Alexandria branch team; bring the new catalogue.',
      priority: 'medium',
      start: d(6),
      deadline: d(10),
      status: 'not_started',
    },
    {
      who: 'khaled',
      dept: sales,
      title: 'Prospect 15 new SMB accounts in Nasr City',
      priority: 'high',
      start: d(-12),
      deadline: d(9),
      goal: 'khaledSales',
      status: 'in_progress',
      notes: ['8 visits done, 3 interested, 1 trial order.'],
    },
    {
      who: 'mona',
      dept: sales,
      title: 'Review Q4 sales plan with management',
      priority: 'urgent',
      start: d(-3),
      deadline: d(1),
      checklist: ['Targets per rep', 'Discount policy', 'Marketing budget'],
      done: 2,
      status: 'in_progress',
    },
    {
      who: 'mona',
      dept: sales,
      title: 'Approve new supplier price list',
      priority: 'high',
      start: d(-20),
      deadline: d(-15),
      status: 'completed',
    },
    {
      who: 'omar',
      dept: ops,
      title: 'Monthly stock count — Main warehouse',
      priority: 'high',
      start: d(-2),
      deadline: d(3),
      checklist: [
        'Zone A — paper',
        'Zone B — printers & ink',
        'Zone C — IT accessories',
        'Variance report',
      ],
      done: 1,
      status: 'in_progress',
    },
    {
      who: 'omar',
      dept: ops,
      title: 'Arrange stock transfer to Alexandria branch',
      priority: 'medium',
      start: d(-10),
      deadline: d(-7),
      status: 'completed',
    },
    {
      who: 'youssef',
      dept: ops,
      title: 'Receive HP toner shipment',
      priority: 'high',
      start: d(-8),
      deadline: d(-6),
      checklist: ['Check delivery note', 'Count cartons', 'Record purchase'],
      done: 3,
      status: 'completed',
    },
    {
      who: 'youssef',
      dept: ops,
      title: 'Label new shelving in Zone B',
      priority: 'low',
      start: d(-5),
      deadline: d(7),
      status: 'on_hold',
      notes: ['Waiting for the label printer ribbon.'],
    },
    {
      who: 'sara',
      dept: finance,
      title: 'Close last month payroll accruals',
      priority: 'high',
      start: d(-19),
      deadline: d(-14),
      status: 'completed',
    },
    {
      who: 'sara',
      dept: finance,
      title: 'Reconcile supplier invoices for this month',
      priority: 'medium',
      start: d(-4),
      deadline: d(6),
      checklist: ['Office Depot Egypt', 'Raya Distribution', 'Al-Ahram Paper'],
      done: 1,
      status: 'in_progress',
    },
    {
      who: 'nour',
      dept: hr,
      title: 'Onboarding plan for the new sales representative',
      priority: 'medium',
      start: d(2),
      deadline: d(12),
      checklist: ['Laptop & email', 'Product training', 'Ride-along with Ahmed'],
      done: 0,
      status: 'not_started',
    },
    {
      who: 'nour',
      dept: hr,
      title: 'Update the leave policy handbook',
      priority: 'low',
      start: d(-14),
      deadline: d(-1),
      status: 'cancelled',
      reason: 'Merged into the new HR policy pack.',
    },
  ];

  const tasks = {};
  for (const plan of taskPlans) {
    const task = await soft(`task ${plan.title}`, () =>
      api(admin, 'POST', '/tasks', {
        title: plan.title,
        description: plan.description ?? null,
        assignee_employee_id: ids[plan.who],
        department_id: plan.dept,
        priority: plan.priority,
        start_date: plan.start,
        deadline: plan.deadline,
        goal_id: plan.goal ? (goals[plan.goal] ?? null) : null,
        checklist: plan.checklist ?? [],
      }),
    );
    if (!task) continue;
    tasks[plan.title] = task.id;
    const token = tokens[plan.who];
    if (plan.status === 'not_started') continue;
    if (plan.status === 'cancelled') {
      await soft('cancel task', () =>
        api(admin, 'POST', `/tasks/${task.id}/status`, {
          status: 'cancelled',
          reason: plan.reason,
        }),
      );
      continue;
    }
    await soft('start task', () =>
      asOrAdmin(token, admin, 'POST', `/tasks/${task.id}/status`, { status: 'in_progress' }),
    );
    const detail = await soft('read task', () =>
      asOrAdmin(token, admin, 'GET', `/tasks/${task.id}`),
    );
    const items = detail?.checklist ?? detail?.checklist_items ?? [];
    for (const item of items.slice(0, plan.done ?? 0)) {
      await soft('tick checklist', () =>
        asOrAdmin(token, admin, 'PATCH', `/tasks/${task.id}/checklist/${item.id}`, {
          is_completed: true,
        }),
      );
    }
    for (const note of plan.notes ?? []) {
      await soft('progress note', () =>
        asOrAdmin(token, admin, 'POST', `/tasks/${task.id}/progress-updates`, { note }),
      );
    }
    if (plan.status === 'completed' || plan.status === 'on_hold') {
      await soft(`task → ${plan.status}`, () =>
        api(token, 'POST', `/tasks/${task.id}/status`, {
          status: plan.status,
          confirm_open_items: true,
        }).catch(() =>
          api(admin, 'POST', `/tasks/${task.id}/status`, {
            status: plan.status,
            confirm_open_items: true,
          }),
        ),
      );
    }
  }
  return tasks;
}

async function seedRequests(admin, tokens, ids, tasks, today) {
  const plans = [
    {
      who: 'ahmed',
      category: 'salary',
      subject: 'Salary certificate for a bank loan',
      description: 'Please issue a salary certificate addressed to Banque Misr.',
      decision: ['approve', 'Issued — collect it from HR on Sunday.'],
    },
    {
      who: 'ahmed',
      category: 'general',
      subject: 'Replacement laptop charger',
      description: 'My laptop charger stopped working; I am using a borrowed one.',
    },
    {
      who: 'ahmed',
      category: 'task',
      subject: 'Deadline extension for CRM contacts update',
      description: 'Need two more days — waiting for contact details from Nile Clinics.',
      task: 'Update CRM contacts for new accounts',
    },
    {
      who: 'nour',
      category: 'general',
      subject: 'Budget for HR certification course',
      description: 'Requesting approval for the SHRM-CP preparation course (EGP 9,500).',
    },
    {
      who: 'youssef',
      category: 'general',
      subject: 'Replace worn safety shoes',
      description: 'Current pair is damaged; size 43.',
      decision: ['approve', 'Approved — purchase from the usual supplier.'],
    },
    {
      who: 'khaled',
      category: 'salary',
      subject: 'Salary advance',
      description: 'Requesting an advance of EGP 5,000 to be deducted over two months.',
      decision: ['reject', 'Advances are paused until the Q4 budget is approved.'],
    },
  ];
  for (const plan of plans) {
    const created = await soft(`request ${plan.subject}`, () =>
      api(tokens[plan.who], 'POST', '/requests', {
        category: plan.category,
        subject: plan.subject,
        description: plan.description,
        ...(plan.task && tasks[plan.task] ? { task_id: tasks[plan.task] } : {}),
      }),
    );
    if (!created || !plan.decision) continue;
    const [decision, admin_response] = plan.decision;
    await soft(`${decision} request`, () =>
      api(admin, 'POST', `/requests/${created.id}/${decision}`, { admin_response }),
    );
  }

  // An attendance correction awaiting review, on Ahmed's most recent late day.
  const yesterday = addDays(today, -1);
  const records = await soft('read attendance', () =>
    api(
      admin,
      'GET',
      `/attendance?employee_id=${ids.ahmed}&from=${iso(addDays(today, -10))}&to=${iso(yesterday)}`,
    ),
  );
  const late = Array.isArray(records)
    ? (records.find((r) => r.status === 'late') ?? records.find((r) => r.status === 'present'))
    : undefined;
  if (late) {
    const date = typeof late.date === 'string' ? late.date.slice(0, 10) : null;
    if (date) {
      const [y, m, dd] = date.split('-').map(Number);
      await soft('correction', () =>
        api(tokens.ahmed, 'POST', '/attendance-corrections', {
          date,
          requested_check_in: instantAt(
            { year: y, month: m, day: dd },
            9 * 60 + 2,
            TIMEZONE,
          ).toISOString(),
          reason:
            'I was at the client office (Delta Pharma) from 9:00; checked in late from the app.',
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 6 — warehouses and inventory (API)
// ---------------------------------------------------------------------------

async function seedInventory(admin) {
  const warehouses = {};
  for (const [key, dto] of Object.entries({
    main: {
      name_ar: 'المستودع الرئيسي — العبور',
      name_en: 'Main Warehouse — Obour',
      type: 'main',
      address: 'Industrial Zone A, Obour City, Cairo',
    },
    alex: {
      name_ar: 'فرع الإسكندرية',
      name_en: 'Alexandria Branch',
      type: 'branch',
      address: '14 Fouad Street, Alexandria',
    },
    showroom: {
      name_ar: 'معرض مدينة نصر',
      name_en: 'Nasr City Showroom',
      type: 'store',
      address: '22 Abbas El-Akkad, Nasr City, Cairo',
    },
  })) {
    warehouses[key] = (await api(admin, 'POST', '/warehouses', dto)).id;
  }

  const categories = {};
  for (const [key, dto] of Object.entries({
    paper: { name_ar: 'الورق والمطبوعات', name_en: 'Paper & Print' },
    ink: { name_ar: 'الطابعات والأحبار', name_en: 'Printers & Ink' },
    it: { name_ar: 'ملحقات الحاسب', name_en: 'IT Accessories' },
    furniture: { name_ar: 'أثاث مكتبي', name_en: 'Office Furniture' },
  })) {
    categories[key] = (await api(admin, 'POST', '/product-categories', dto)).id;
  }

  const suppliers = {};
  for (const [key, dto] of Object.entries({
    ahram: {
      name: 'Al-Ahram Paper Co.',
      contact_person: 'Hany Samir',
      phone: '+20 2 2575 1100',
      email: 'sales@ahram-paper.example',
      address: '6th of October City, Giza',
    },
    raya: {
      name: 'Raya Distribution',
      contact_person: 'Dina Fathy',
      phone: '+20 2 3827 6000',
      email: 'b2b@raya-dist.example',
      address: 'Smart Village, Giza',
    },
    depot: {
      name: 'Office Depot Egypt',
      contact_person: 'Tamer Nabil',
      phone: '+20 2 2690 4410',
      email: 'orders@officedepot-eg.example',
      address: 'New Cairo, Cairo',
    },
  })) {
    suppliers[key] = (await api(admin, 'POST', '/suppliers', dto)).id;
  }

  const products = [
    [
      'A4 copy paper 80gsm (box of 5 reams)',
      'ورق تصوير A4 80 جرام (كرتونة 5 رزم)',
      'PAP-A4-80',
      'paper',
      'ahram',
      'box',
      '40',
      '610.00',
      '780.00',
      '220',
    ],
    [
      'A3 copy paper 80gsm (ream)',
      'ورق تصوير A3 80 جرام (رزمة)',
      'PAP-A3-80',
      'paper',
      'ahram',
      'ream',
      '25',
      '245.00',
      '320.00',
      '90',
    ],
    [
      'Thermal receipt rolls 80mm (pack of 10)',
      'رولات حرارية 80 مم (عبوة 10)',
      'PAP-THR-80',
      'paper',
      'ahram',
      'pack',
      '30',
      '150.00',
      '205.00',
      '60',
    ],
    [
      'HP 85A black toner cartridge',
      'خرطوشة حبر HP 85A أسود',
      'INK-HP85A',
      'ink',
      'raya',
      'pcs',
      '20',
      '1850.00',
      '2350.00',
      '48',
    ],
    [
      'Canon PG-545 ink cartridge',
      'خرطوشة حبر Canon PG-545',
      'INK-CN545',
      'ink',
      'raya',
      'pcs',
      '15',
      '540.00',
      '720.00',
      '35',
    ],
    [
      'HP LaserJet Pro M404dn printer',
      'طابعة HP LaserJet Pro M404dn',
      'PRN-HPM404',
      'ink',
      'raya',
      'pcs',
      '4',
      '14800.00',
      '17900.00',
      '9',
    ],
    [
      'Logitech wireless keyboard & mouse set',
      'لوحة مفاتيح وماوس لاسلكي Logitech',
      'IT-LGMK270',
      'it',
      'raya',
      'pcs',
      '15',
      '1250.00',
      '1650.00',
      '40',
    ],
    [
      'USB-C docking station',
      'محطة توصيل USB-C',
      'IT-DOCK-C',
      'it',
      'depot',
      'pcs',
      '6',
      '3900.00',
      '4950.00',
      '14',
    ],
    [
      '24" Full HD monitor',
      'شاشة 24 بوصة Full HD',
      'IT-MON24',
      'it',
      'depot',
      'pcs',
      '5',
      '5600.00',
      '6900.00',
      '12',
    ],
    [
      'Ergonomic office chair',
      'كرسي مكتب مريح',
      'FUR-CHAIR-E',
      'furniture',
      'depot',
      'pcs',
      '6',
      '4200.00',
      '5600.00',
      '10',
    ],
    [
      'Steel filing cabinet, 4 drawers',
      'دولاب ملفات معدني 4 أدراج',
      'FUR-CAB-4',
      'furniture',
      'depot',
      'pcs',
      '3',
      '3100.00',
      '3990.00',
      '5',
    ],
    [
      'Whiteboard 120×90 cm',
      'سبورة بيضاء 120×90 سم',
      'FUR-WB-120',
      'furniture',
      'depot',
      'pcs',
      '4',
      '1150.00',
      '1490.00',
      '8',
    ],
  ];
  const ids = {};
  for (const [
    name_en,
    name_ar,
    sku,
    category,
    supplier,
    unit,
    min_stock,
    cost,
    sell,
    qty,
  ] of products) {
    const product = await api(admin, 'POST', '/products', {
      name_en,
      name_ar,
      sku,
      unit,
      category_id: categories[category],
      supplier_id: suppliers[supplier],
      min_stock,
      cost_price: cost,
      selling_price: sell,
      initial_stock: { warehouse_id: warehouses.main, quantity: qty, unit_cost: cost },
    });
    ids[sku] = { id: product.id, cost };
  }

  const move = (sku, warehouse, type, quantity, reason, unit_cost) =>
    soft(`movement ${type} ${sku}`, () =>
      api(admin, 'POST', '/stock-movements', {
        product_id: ids[sku].id,
        warehouse_id: warehouses[warehouse],
        type,
        quantity,
        ...(unit_cost ? { unit_cost } : {}),
        reason,
      }),
    );
  const transfer = (source, destination, lines, note) =>
    soft(`transfer ${source}→${destination}`, () =>
      api(admin, 'POST', '/warehouses/transfers', {
        source_warehouse_id: warehouses[source],
        destination_warehouse_id: warehouses[destination],
        lines: lines.map(([sku, quantity]) => ({ product_id: ids[sku].id, quantity })),
        note,
      }),
    );

  await move(
    'INK-HP85A',
    'main',
    'purchase',
    '24',
    'PO-2026-1187 from Raya Distribution',
    '1820.00',
  );
  await move('PAP-A4-80', 'main', 'purchase', '120', 'PO-2026-1192 from Al-Ahram Paper', '600.00');
  await transfer(
    'main',
    'alex',
    [
      ['PAP-A4-80', '60'],
      ['INK-HP85A', '12'],
      ['IT-LGMK270', '10'],
    ],
    'Monthly replenishment — Alexandria',
  );
  await transfer(
    'main',
    'showroom',
    [
      ['PRN-HPM404', '3'],
      ['IT-MON24', '4'],
      ['FUR-CHAIR-E', '4'],
      ['IT-DOCK-C', '3'],
    ],
    'Showroom display stock',
  );
  await move('PAP-A4-80', 'main', 'sale', '95', 'INV-24811 Delta Pharma');
  await move('INK-HP85A', 'main', 'sale', '38', 'INV-24816 Nile Clinics');
  await move('PAP-A4-80', 'alex', 'sale', '32', 'INV-A-1093 Alexandria Port Authority');
  await move('IT-LGMK270', 'main', 'sale', '27', 'INV-24820 Horizon Schools');
  await move('PRN-HPM404', 'showroom', 'sale', '2', 'Walk-in sale — showroom');
  await move('IT-MON24', 'main', 'sale', '7', 'INV-24829 Cairo Logistics');
  await move('INK-CN545', 'main', 'sale', '22', 'INV-24833 Heliopolis cafés');
  await move('IT-DOCK-C', 'main', 'sale', '11', 'INV-24840 Delta Pharma IT');
  await move('FUR-CAB-4', 'main', 'sale', '5', 'INV-24842 Horizon Schools admin office');
  await move('PAP-THR-80', 'main', 'sale', '38', 'INV-24845 Nasr City retail cluster');
  await move('FUR-WB-120', 'main', 'damage', '1', 'Cracked during unloading');
  await move('PAP-A3-80', 'main', 'adjustment', '-3', 'Cycle count variance — Zone A');
  await move('INK-HP85A', 'main', 'return', '2', 'Customer return — unopened (Nile Clinics)');

  await soft('reconciliation', () => api(admin, 'POST', '/inventory/reconciliation', {}));
  return warehouses;
}

// ---------------------------------------------------------------------------
// Stage 7 — payroll and monthly reports (API)
// ---------------------------------------------------------------------------

async function seedPayroll(admin, ids, today) {
  const results = [];
  for (const offset of [-2, -1]) {
    const month = monthStart(today, offset);
    const period = await soft(`payroll ${month.year}-${month.month}`, () =>
      api(admin, 'POST', '/payroll/periods', {
        year: month.year,
        month: month.month,
        proceed_with_warnings: true,
      }),
    );
    if (!period) continue;
    if (offset === -1) {
      const detail = await soft('payroll period', () =>
        api(admin, 'GET', `/payroll/periods/${period.id}`),
      );
      const lines = detail?.lines ?? detail?.period?.lines;
      const lineFor = (employeeId) =>
        Array.isArray(lines)
          ? lines.find((l) => (l.employee?.id ?? l.employee_id) === employeeId)
          : undefined;
      const ahmedLine = lineFor(ids.ahmed);
      if (ahmedLine)
        await soft('bonus', () =>
          api(admin, 'POST', `/payroll/lines/${ahmedLine.id}/bonuses`, {
            type: 'commission',
            amount: '2500.00',
            reason: 'Sales commission — Delta Pharma contract',
          }),
        );
      const khaledLine = lineFor(ids.khaled);
      if (khaledLine)
        await soft('bonus', () =>
          api(admin, 'POST', `/payroll/lines/${khaledLine.id}/bonuses`, {
            type: 'commission',
            amount: '1200.00',
            reason: 'Sales commission — SMB accounts',
          }),
        );
      const youssefLine = lineFor(ids.youssef);
      if (youssefLine)
        await soft('deduction', () =>
          api(admin, 'POST', `/payroll/lines/${youssefLine.id}/deductions`, {
            type: 'other',
            amount: '350.00',
            reason: 'Damaged whiteboard — agreed partial cost',
          }),
        );
    }
    await soft('submit review', () =>
      api(admin, 'POST', `/payroll/periods/${period.id}/submit-review`, {}),
    );
    await soft('approve', () => api(admin, 'POST', `/payroll/periods/${period.id}/approve`, {}));
    await soft('finalize', () =>
      api(admin, 'POST', `/payroll/periods/${period.id}/finalize`, {
        confirm: `${month.year}-${String(month.month).padStart(2, '0')}`,
      }),
    );
    if (offset === -2) {
      await soft('mark paid', () =>
        api(admin, 'POST', `/payroll/periods/${period.id}/mark-paid`, {}),
      );
    }
    results.push(period.id);
  }

  const last = monthStart(today, -1);
  for (const employee of EMPLOYEES) {
    await soft(`monthly report ${employee.key}`, () =>
      api(
        admin,
        'POST',
        `/reports/employee/${ids[employee.key]}/monthly/${last.year}/${last.month}/generate`,
        {},
      ),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------

async function main() {
  const prisma = createPrismaClient(requireEnv('DATABASE_MIGRATION_URL'));
  try {
    const today = todayInCairo();
    console.log(`Demo seed against ${API} for ${iso(today)} (Africa/Cairo).`);

    const company = await seedCompanyAndAdmin(prisma);
    if (company.alreadySeeded) {
      console.log('Demo company already has employees — nothing to do.');
      return;
    }
    const admin = await login(ADMIN.email, ADMIN.password);

    console.log('• structure');
    const structure = await seedStructure(admin, today);
    console.log('• employees');
    const ids = await seedEmployees(admin, structure);
    const tokens = await activateAccounts(prisma);
    console.log('• salaries and leave');
    await seedSalaries(admin, ids);
    const types = await seedLeaveTypes(admin);
    const leaveDays = await seedLeave(admin, tokens, types, today);
    console.log('• attendance history');
    const written = await seedAttendance(prisma, today, structure.holidays, leaveDays);
    console.log(`  ${written} attendance days`);
    console.log('• tasks and goals');
    const tasks = await seedTasksAndGoals(admin, tokens, ids, structure, today);
    console.log('• requests');
    await seedRequests(admin, tokens, ids, tasks, today);
    console.log('• inventory');
    await seedInventory(admin);
    console.log('• payroll and monthly reports');
    await seedPayroll(admin, ids, today);
    console.log('Demo company seeded.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
