# DOCUMENT 23 — PUBLIC WEBSITE SPECIFICATION

## PURPOSE
Explain what أُفق is, who it is for, and why it is worth trusting with a company's payroll and stock — then convert the visitor into a registration or a contact.

## CRITICAL RULE

**The marketing website must not look like the ERP dashboard.** It shares the design system — the same palette, the same type scale, the same warmth — but not the layout language. No sidebar. No KPI cards. No data tables as decoration.

The relationship is: *same family, different room.*

## WHAT IT MUST COMMUNICATE
Simplicity · Control · Visibility · Productivity · Business management · Employee management · Financial clarity.

Trust is the underlying message. The visitor is being asked to put their salary data into someone else's software.

## PAGES

### 1. Home `/`
- **Hero:** the أُفق wordmark and a clear Arabic value line — one sentence stating what the product does, not a slogan. Primary CTA "ابدأ الآن", secondary "شاهد المميزات". Deep-green hero surface with the horizon/landscape motif from the brand illustration.
- **Problem section:** the disconnected-tools reality, stated plainly.
- **Solution section:** the connected chain — attendance → payroll, tasks → performance, stock → valuation.
- **Feature highlights:** six cards with icons, each linking to Features.
- **Product visual:** one honest screenshot or clean mockup of the dashboard. Not an invented interface.
- **Audience split:** two panels, For Companies and For Individuals (the latter marked قريباً).
- **Trust section:** security, data isolation, audit trail, backups.
- **Final CTA + footer.**

### 2. About `/about`
The meaning of أُفق, why it exists, who it is built for, the team, and the product philosophy: Arabic-first, serious ERP, built for real SMEs rather than enterprise theatre.

### 3. Features `/features`
Organised by module, each with a short explanation and a supporting visual:
Attendance & work modes · Employees · Tasks & checklists · Goals & performance · Leave · Payroll · Warehouse & inventory · Reports · Notifications.

Written in outcomes, not feature lists. "اعرف من في المكتب ومن يعمل عن بُعد، ثم اربط ذلك بالراتب تلقائياً" — not "attendance module with WFH support".

### 4. For Companies `/for-companies`
Company sizes served, the modules that matter to each, the onboarding path, and the answer to "how long until we are running".

### 5. For Individuals `/for-individuals`
The planned individual edition. Marked clearly as قريباً with an email capture for launch notification. **Do not imply it exists.**

### 6. Pricing `/pricing`
Tiers, what each includes, employee-count bands, an FAQ, and a contact route for larger companies. If pricing is not finalised (OD-15), the page shows a contact-for-pricing form instead of invented numbers.

### 7. Contact `/contact`
Form: name, company, email, phone, message, enquiry type. Plus direct contact details and expected response time. Rate limited and spam protected.

### 8. Login `/login`
Uses the application's auth screen. Consistent with the app, reachable from the site header.

### 9. Register `/register`
Company registration: company name, admin name, email, phone, employee-count range, password. Creates the company and the first ADMIN user, then triggers email verification and the onboarding checklist.

## DESIGN DIRECTION
- **Palette:** the same tokens as DOCUMENT 10. Deep green for hero and footer surfaces, cream backgrounds, bright green for CTAs only, sage and gold as accents.
- **Illustration:** the horizon and landscape motif from the brand reference — layered hills in sage, olive, and brown with a pale gold sun. Used as section dividers and hero backdrops.
- **Typography:** the display scale from the design system, reserved for marketing.
- **Layout:** generous whitespace, wide sections, centred content up to 1200px, `space-16` between sections.
- **Imagery:** honest product visuals only. Never a mocked-up interface that does not exist.
- **Motion:** subtle fade and rise on scroll, respecting `prefers-reduced-motion`.

## TECHNICAL REQUIREMENTS
| Requirement | Rule |
|---|---|
| Rendering | Server-rendered or static. Marketing pages must not require JavaScript to read |
| Performance | LCP under 2.5s on a 4G connection |
| SEO | Arabic-first metadata, semantic headings, Open Graph, structured data, sitemap, robots.txt |
| Language | Arabic default with an English version at `/en`, and `hreflang` links |
| RTL | Default, per the design system |
| Analytics | Privacy-respecting, with a cookie consent banner if any non-essential cookie is set |
| Accessibility | Same standard as the application — 4.5:1 contrast, keyboard navigable, semantic markup |
| Forms | Rate limited, spam protected, server-validated |
| Security | No app session on marketing pages; registration and contact are the only write endpoints |

## CONTENT RULES
1. Arabic is written first, then translated to English. Not the reverse — translated-from-English Arabic reads like translated-from-English Arabic.
2. No feature is claimed that V1 does not deliver.
3. The individual edition is always marked as forthcoming.
4. Security claims are specific and true: "عزل كامل لبيانات كل شركة" and "سجل تدقيق لكل عملية" — never a vague "bank-level security".
5. Screenshots are updated when the UI changes. A stale screenshot is a broken promise.

## CONVERSION PATHS
```
Home → Features → For Companies → Register
Home → Pricing → Contact
Home → Register (direct)
Any page → Login (existing customers)
```

The primary CTA is present in the header on every page and repeated at the foot of every content page.

## FUTURE EXTENSIONS
Blog and content marketing, customer case studies, a help centre and documentation site, live chat, a demo request booking flow, an interactive product tour, and comparison pages. None required for launch.
