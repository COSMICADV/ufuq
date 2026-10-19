# Phase 16 — Public Website: status

**Roadmap reference:** DOCUMENT 25, Phase 16; DOCUMENT 23, with the approved Phase 16 handoff and contact-delivery decision.

**Status: COMPLETE.** Local commit: `Complete Phase 16: Public Website`. Nothing pushed.

## Recovered state and scope

Started from clean `main`, `e612d12 — Complete Phase 15: Notifications`, after reading the complete supplied handoff. No earlier phase was restarted or broadly re-audited. The handoff and explicit SMTP contact decision resolve OD-15/OD-17 and contact handling.

All nine functional pages are present. Arabic is the default even when the browser prefers English; English is explicitly `/en`. Marketing content is server/static rendered, separate from the ERP layout. The current green/cream design tokens remain in use. The final Visual Identity V2 redesign, Phase 17 and deployment were not started.

## Routes and content

| Arabic             | English               | Content / action                                                                                                                                                                                                             |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                | `/en`                 | Clear value proposition; start/features CTAs; disconnected tools problem; five connected operation chains; six feature highlights; real product screenshot; company/individual split; specific trust capabilities; final CTA |
| `/about`           | `/en/about`           | Meaning of UFUQ; Arabic-first philosophy; SMEs; connected operations; simplicity and control. No invented team/history                                                                                                       |
| `/features`        | `/en/features`        | Employees, attendance/work modes, tasks/checklists, goals/performance, requests, leave, payroll, warehouse, inventory, reports, in-app notifications; actual task-screen visual                                              |
| `/for-companies`   | `/en/for-companies`   | Employee operations, payroll, stock, reporting; five-step onboarding using existing screens                                                                                                                                  |
| `/for-individuals` | `/en/for-individuals` | Clearly Coming Soon; company edition available; no interest-capture endpoint                                                                                                                                                 |
| `/pricing`         | `/en/pricing`         | Contact for pricing; employee count and needs; no invented prices, plan limits or commitments                                                                                                                                |
| `/contact`         | `/en/contact`         | Name, company, email, phone, enquiry type, message; real SMTP delivery                                                                                                                                                       |
| `/login`           | `/en/login`           | Existing auth API and cookies; password visibility, remember-me, existing reset-request API; role-aware destination                                                                                                          |
| `/register`        | `/en/register`        | Company name, admin name, email, phone, employee-count range, password; first ADMIN registration and existing email activation                                                                                               |

Arabic public URLs rewrite internally to the existing locale layout. Existing `/ar/...` application and invitation URLs remain valid; Arabic public aliases have canonical unprefixed URLs. Private routes retain their existing authentication and authorization boundaries.

Header: brand, Home, Features, For Companies, Pricing, Contact, language, Login, Register. Native mobile disclosure remains keyboard accessible. Footer links all nine pages and the equivalent language route. No fake address, phone, testimonial, price, company history or unsupported product claim is published. The two product screenshots show the actual current task screen with local sample records created through the real API; no invented interface is used.

Public copy lives in `@ufuq/i18n` (`public-site.ts`), with Arabic and English parity checks. Marketing CSS is scoped under `.public-site`, using the existing design tokens and logical properties.

## Registration and authentication

`POST /api/v1/public/register`:

1. Rate limit, whitelist validation, origin/spam checks and existing password policy (10-character minimum plus breach check), with the existing auth API’s 200-character input maximum.
2. Generate the tenant UUID on the server and bind it through the existing tenant transaction boundary. An email advisory lock serializes competing registrations. Existing auth lookup is reused; no client tenant or role is accepted.
3. In one transaction: create company, first **invited ADMIN** with password hash/name/phone, set company creator and employee-count range, and issue the existing hashed, single-use invitation. The existing post-commit audit dispatcher records `invitation.sent`.
4. After commit, reuse `InvitationMailer` and SMTP. The 72-hour activation token travels in the URL fragment and is never returned in the registration response or logged.
5. Existing `accept-invitation` page/endpoint activates the account and verifies its email. That existing screen asks the administrator to choose the final password and accept the existing terms checkbox. Login remains blocked until activation.
6. The activation success now links to the real login page. Login calls `/auth/login` and `/auth/me`, using the existing session/CSRF cookie flow. ADMIN enters company settings, MANAGER the admin workspace, EMPLOYEE the employee workspace. Existing structure/schedule/employee screens provide the onboarding path; no new onboarding subsystem.

**Atomicity proof:** a forced failure after the company and user writes, at invitation issuance, produces HTTP 500 with safe text and leaves neither company nor user; no mail is sent. The success test verifies company creator, registration metadata, ADMIN role, invitation preview/acceptance, single-use token, blocked pre-activation login, authenticated company settings and an empty new-company employee list. Duplicate active accounts conflict rather than creating another tenant.

**SMTP retry:** the database commit and SMTP are deliberately separate. A delivery failure returns generic 503 but leaves the company and first account together in an unverified state. Resubmitting with the original credentials reissues activation to the same account without creating another company; a wrong password cannot trigger that resend. The form retains entries on error.

### Migration implications

`20261020000000_phase16_public_website` is additive:

- `companies.employee_count_range`, nullable with a four-band check;
- `users.display_name` and `users.phone`, nullable.

Existing rows remain NULL. Existing invitations, sessions, operational records, RLS policies and tenant grants are unchanged. No data is rewritten. Reversing the migration would drop only these metadata columns and lose their values. Apply it before starting the new API version; seed the existing system roles/permissions before accepting registrations.

## Contact delivery — approved decision

`POST /api/v1/public/contact` is a separate public transactional email flow, not a Phase 15 notification channel.

- **From:** existing configured `MAIL_FROM`, applied by `SmtpMailTransport`.
- **To:** environment-specific `CONTACT_TO`.
- **Reply-To:** validated, normalized submitter email.
- Fixed safe subject and bilingual labels for enquiry type, name, company, phone, email and message. HTML escapes submitted text; `dir="auto"` and preserved newlines handle either script. Plain text contains the same fields.
- Name/company reject controls and markup; emails, normalized Arabic/Latin phone digits, phone syntax, type whitelist and field lengths are validated server-side; unknown fields are refused. Message markup is inert in HTML mail. No visitor-selected recipient/sender is accepted.
- Success is returned only after the transport accepts delivery. Missing recipient or SMTP failure returns generic retryable 503, without internal details. Inputs remain available for retry.
- No message body or unnecessary contact PII is logged. No enquiry database or admin enquiry-management UI was added.

Tests use a fake transport and assert correct delivery/Reply-To/content, acceptance ordering, failures/retry, validation, malicious input, escaping, throttling, honeypot/time checks, origin checks and configuration. A separate Nodemailer-boundary test verifies the configured application From and supplied Reply-To are passed correctly.

## Public security, SEO and rendering

- Marketing pages require no app session. Only registration/contact public writes were added; existing auth endpoints are reused.
- Redis-backed **five attempts per IP per endpoint per hour**, with `Retry-After`. A route guard runs before DTO validation, so invalid requests consume the same budget.
- Honeypot, minimum completion time (1.5 seconds), maximum form age (24 hours), same-origin browser submissions, body whitelist/length checks and output escaping. These are basic abuse controls, not a claim that bots cannot bypass heuristics.
- Existing Argon2 hashing, role grants, RLS, invitation lifecycle, cookie flags, CSRF and authenticated API boundaries remain authoritative.
- Unknown registration failures are converted to safe errors before the global logger can include a Prisma stack containing submitted values.
- Unique bilingual titles/descriptions, canonical URLs, `hreflang` (Arabic/English/x-default), Open Graph, one semantic H1 per page, truthful `WebSite` structured data, bilingual sitemap and robots rules.
- Sitemap contains the seven indexable marketing pages in both languages; Login/Register are functional public pages with `noindex`. Private/auth-token paths are disallowed in robots. Robots is not an access-control mechanism; APIs enforce access.
- Informational marketing pages are prerendered static HTML. Login's optional reset view is rendered on the server. JavaScript is needed only for interactive form submissions, not reading the content. Mobile navigation uses native HTML disclosure.
- No analytics, tracking script, non-essential cookie or animation library was introduced. Reduced motion is respected. Fonts use the established system fallback without remote font fetches; images have dimensions and responsive optimization.

## Browser, accessibility and performance evidence

Verified in Chrome **155.0.8059.80**, against a production Next.js build and an explicitly enabled loopback-only disposable PostgreSQL fixture. Redis network and SMTP delivery were replaced with test implementations; the actual Nest HTTP pipeline, RLS, registration transactions, hashing, token acceptance and cookie sessions ran for real.

- **18 route/language combinations**, all nine routes in Arabic RTL and English LTR.
- **180 responsive checks:** each route/language at 375, 800, 1280 px, plus the repository's 360, 390, 430, 768, 1024, 1440 and 1920 px references. No page-level horizontal overflow.
- **54 axe WCAG 2 A/AA + 2.1 AA scans** at 375/800/1280 px: **zero violations**. Public controls/links at mobile/tablet have at least 44×44 px targets; buttons are at least 48 px high.
- Header/footer links, language switching, native mobile disclosure, keyboard skip-to-content, CTAs and both conversion chains verified. Twenty distinct public URL/query destinations returned 200.
- All 18 pages remain readable with JavaScript disabled; language/direction, titles, descriptions, canonical/hreflang and structured data were inspected in the browser.
- **Actual Arabic and English contact submissions** reached the fake mail transport with correct Reply-To. Native invalid-email validation, loading/disabled controls, safe server error, preserved input and retry were exercised.
- **Actual Arabic and English company registrations**: email captured at the transport, activation link followed, existing password/terms flow completed, real cookie login submitted, correct new company's settings loaded.
- Protected endpoints without credentials return 401 in the HTTP suite. Registration rollback, single-use activation, duplicates and SMTP failure/retry are tested, not inferred from a successful page render.

Local measured profile: 375×844 viewport, 150 ms latency, 1.6 Mbps downstream, 750 Kbps upstream, 4× CPU slowdown, fresh contexts. PerformanceObserver LCP/CLS, production build:

| Page     | Arabic LCP | English LCP | CLS |
| -------- | ---------- | ----------- | --- |
| Home     | 648 ms     | 620 ms      | 0   |
| Features | 1032 ms    | 1044 ms     | 0   |

All measured LCP values are below 2.5 seconds. This is a local throttled browser measurement, not field data or a production network guarantee. Home screenshots were also inspected visually in both languages. The full matrix and form checks were rerun after the last layout change.

### Reproducing browser verification

`scripts/verify-phase16.cjs` uses Playwright and axe tooling supplied externally through `PLAYWRIGHT_MODULE` / `AXE_MODULE` (or ordinary module resolution), without adding runtime dependencies to the product. Run a production web build on localhost:3000 and the disposable fixture:

```sh
PHASE16_PREVIEW=1 pnpm --filter @ufuq/api exec vitest run test/public-site.e2e.test.ts -t 'local browser preview fixture'
node scripts/verify-phase16.cjs
```

The fixture binds only loopback localhost:4000, uses no production database, starts no background jobs and captures only test mail into a mode-0600 temporary file. Remove any stale `/private/tmp/ufuq-phase16-preview-done` marker before starting it. Touch that marker to end the fixture normally, then remove its temporary captured mail. The opt-in preview test is not part of the normal test total. Browser output is written to `/private/tmp/ufuq-phase16-browser-results.json`.

## Final test/build gate

Final uncached workspace gate after implementation and verification:

| Check                    | Result                                                 |
| ------------------------ | ------------------------------------------------------ |
| `pnpm format:check`      | Pass                                                   |
| `pnpm lint --force`      | Pass — 0 errors; 4 existing `no-console` seed warnings |
| `pnpm typecheck --force` | Pass                                                   |
| `pnpm test --force`      | Pass — **1,835 tests**, 0 failures                     |
| `pnpm build --force`     | Pass                                                   |

The `--force` flag is passed to the existing Turborepo workspace scripts; no task results are reused from cache.

| Package        | Test files | Tests     |
| -------------- | ---------- | --------- |
| `@ufuq/api`    | 41         | 1,101     |
| `@ufuq/db`     | 17         | 335       |
| `@ufuq/web`    | 22         | 282       |
| `@ufuq/auth`   | 5          | 44        |
| `@ufuq/money`  | 1          | 25        |
| `@ufuq/config` | 1          | 24        |
| `@ufuq/i18n`   | 1          | 20        |
| `@ufuq/mobile` | 1          | 4         |
| **Total**      | **89**     | **1,835** |

Phase 16 adds 50 tests: API 42, web 4, configuration 4. Existing business, financial, permission and tenant-isolation suites continue to pass.

## Defects caught and corrected during Phase 16

- Manager sign-in originally led to admin-only company settings; destinations now follow the real role.
- Shared public form state could survive navigation between contact/register; forms now remount for page/language/reset mode changes.
- Rate limiting initially occurred after DTO validation; a guard now limits invalid attempts as well.
- Unexpected registration exceptions could reach raw Prisma error logging; the public controller now raises a safe error without submitted values.
- Password validation initially differed from the existing policy; registration now references its authoritative minimum and breach check. Public login/registration also preserve the existing 200-character input maximum, verified at the lower and upper boundaries.
- Small public link/password-toggle targets were enlarged to meet mobile requirements.
- Configuration expectations were updated for the new optional recipient; integration assertions explicitly inspect database state as a test administrator rather than accidentally reading zero rows through RLS.

## Accepted limitations and deployment requirements

- Supply real production `CONTACT_TO`, SMTP relay/credentials and `MAIL_FROM` at deployment. The committed recipient is **local Mailpit only**, not an invented production address. Missing `CONTACT_TO` makes contact submission return safe 503.
- Set `WEB_ORIGIN` for both API CORS and build-time absolute SEO URLs, and `NEXT_PUBLIC_API_ORIGIN` for the actual API endpoint. Rebuild the web application for deployment-specific origins. Apply the migration and seed reference roles/permissions first.
- SMTP acceptance proves handoff to the relay, not final mailbox receipt. No durable contact inbox is stored, as explicitly approved. Failed submissions remain in the browser for retry.
- Existing invitation terms acceptance is reused. The pre-existing Phase 5 absence of a supplied legal terms document remains a deployment/legal-content requirement; no legal text was invented here.
- The existing password-reset request API still records tokens without email delivery. The public login exposes that existing flow with truthful confirmation and administrator-help guidance; extending password-reset delivery is an inherited authentication boundary, not a new notification channel.
- No individual edition, pricing/billing enforcement, interest capture, invasive analytics, email/push notifications or large onboarding subsystem. Those capabilities were not promised.
- Public visuals deliberately retain the current design system. The final global UI redesign is deferred as instructed. Phase 17 and deployment remain unstarted.

**New unresolved [DECISION REQUIRED]: none.** Stop after this phase. Do not push.
