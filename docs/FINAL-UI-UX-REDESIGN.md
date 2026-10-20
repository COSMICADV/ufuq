# UFUQ Final UI/UX Redesign

Baseline: `d1f70f2` — Complete Phase 16: Public Website. Scope: presentation and accessibility across the existing product. Phase 17, deployment and pushing are outside this change.

## Coverage and visual architecture

[The pre-change route inventory](FINAL-UI-UX-ROUTE-INVENTORY.md) lists all 63 existing page modules. The dynamic marketing route serves nine named pages; employee profile tabs, report keys, detail routes, request categories, checklist states and dialogs are part of the coverage, rather than separate showcase screens.

Every Admin and Employee page uses `ProductShell`, installed in its existing route layout. Existing screens retain their own headers, data loaders, forms, filters, actions and permission checks. `v2.css` supplies the final shared presentation rules after the existing functional module styles. This keeps workflow code stable while replacing its visual system. No application dependency or large UI framework was added.

The supplied Visual Identity V2 ZIP and eight-page PDF informed the palette, horizon mark, typography, shape, spacing and product distinctions. Their roadmap is reference material, not authorization to introduce features or change application behavior.

## Tokens and typography

`packages/design-tokens/src/tokens.css` and `index.ts` share the V2 palette across web and React Native:

| Purpose                                      | Value     |
| -------------------------------------------- | --------- |
| Navy / navigation / brand anchor             | `#171B38` |
| Indigo / primary actions / selection         | `#5748F5` |
| Lavender / supporting highlights             | `#8A7BFF` |
| Mist Blue / selected and supporting surfaces | `#EAF0FF` |
| Muted Amber / small brand mark accent        | `#DDA45A` |
| White / primary surfaces                     | `#FFFFFF` |
| Canvas                                       | `#F7F8FC` |
| Border                                       | `#E5E7EF` |
| Main text                                    | `#20243B` |
| Muted text                                   | `#667085` |
| Success                                      | `#168653` |
| Error                                        | `#DC4242` |
| Information                                  | `#2165E8` |
| Warning                                      | `#C77B16` |

Semantic text uses darker related shades on pale backgrounds for contrast. Destructive buttons similarly use the accessible dark error shade. Success remains green; brand actions are indigo. Historical token names such as `greenPrimary600` are compatibility aliases containing V2 values, so stable consumers and the native catalogue do not break. They no longer imply the former green visual identity.

Arabic uses Alexandria first; English uses Inter first. The root locale owns the font stack and document direction. The web loads the named families through an external Google Fonts stylesheet with `display=swap` and preconnections. No font binaries are committed or exposed by the application. Offline/restricted networks use the declared system fallback. Native font-family names are external installation references, not a bundled font delivery mechanism.

The product scale is display 32, H1 28, H2 22, H3 18, body 16, small 14, caption 12px. Phone page titles are 24px. Marketing headlines scale to 48px on wide displays and 30px on phones. Arabic line height is deliberately generous; tabular figures retain isolated number/date formatting.

## Spacing and surfaces

The shared spacing scale is 4, 8, 12, 16, 20, 24, 32, 40, 48 and 64px. Product desktop padding is 32px, laptop/tablet 24px, phone 16px horizontally. Typical content gaps are 24px desktop and 16–20px phone.

Cards are white with a 1px border and 16px radius. Buttons/inputs use 12px radius, with inputs 48px high and interactive targets at least 44px where the control's purpose permits. Small status badges are labels, not tap targets. Cards have no default drop shadow. Shadows are reserved for overlays and the real product screenshot in marketing. There is no glassmorphism or decorative gradient layer.

## Shared component rules

- Buttons: indigo primary; white bordered secondary; quiet ghost; dark red destructive. Hover, pressed, focus, loading and disabled are distinct. Loading preserves the label and disables duplicate submission through existing behavior.
- Fields: consistent 48px input/select/date controls; 96px minimum textarea; visible labels; existing required markers, validation messages and server errors. Invalid controls use error borders. Read-only and disabled controls use a cool neutral fill.
- Cards and statistic cards: title/action header, separated body, neutral surface. KPI values use navy and tabular numerals. Delta and status meaning remain semantic.
- Tables: quiet canvas header, aligned numeric values, neutral hover and consistent row spacing. Existing `Cell` labels and module mobile-card transformations remain active. Report matrices and genuinely comparative dense tables scroll inside their own container; the document never needs horizontal scrolling.
- Pagination, tabs, breadcrumbs and filters: one shared sizing and selected-state vocabulary. Filters wrap on larger screens and retain existing phone filter sheets. Tab strips scroll within their own width when labels cannot fit.
- Empty states: bordered neutral panel, compact accent symbol, explanation and the existing next action. They do not masquerade as data or statistics.
- Loading: layout skeletons with a subtle opacity pulse, never a marketing-style shimmer gradient. Error panels preserve existing retry behavior. Success uses the existing live notices.
- Dialogs: the shared controlled `Modal` uses native `dialog.showModal()`. The browser contains focus, makes the background inert, supports Escape, and restores focus on dismissal. Existing destructive/review confirmations and save callbacks are retained. Backdrop dismissal is limited to actual outside clicks.
- Navigation drawers: native modal dialog, labelled close control, keyboard containment, Escape and a scrollable link list. Drawer links close it before navigation.
- Notifications: unread items have an indigo edge, dot, pale fill and stronger title; read items are neutral; unavailable items use the disabled surface. Existing handled/read actions, bell polling and count semantics remain unchanged.
- Existing native selects and date fields remain native controls; no invented combobox replaces supported selection behavior. Existing inline feedback remains the notification/validation pattern rather than adding an unrelated toast framework.

## Admin, Employee and Marketing

### Admin ERP

A navy sidebar anchors a light canvas with white working surfaces. It contains Overview, Employees, Attendance, Tasks, Goals, Requests, Leave, Payroll, Reports, Warehouse, Inventory, Notifications and Settings according to the existing session permissions. Icons share one restrained stroke style. Indigo identifies the current section. Company identity sits at the foot of the navigation.

Headers, filters, actions, tables and detail cards now share consistent type, spacing and states. The dashboard lays out real, independently loading widgets in two columns where width permits. No fake KPIs were added. Employees retain profile tabs and invitation/salary controls; Attendance retains daily/monthly/correction views; Tasks retain list/board/checklists; Goals retain performance and progress; Requests retain category-specific review/leave forms; payroll retains preflight, periods and payslips; reports retain catalogue, viewer, exports and monthly reports; warehouse/inventory retain location, transfer, movement and supplier flows. Settings keep their own secondary section navigation.

### Employee experience

The desktop employee navigation is white and quieter than Admin. The content has a narrower maximum width. Attendance remains the prominent first dashboard card; work mode and the existing check-in/check-out actions retain their rules. Tasks, goals, requests, leave balances and eligible salary/report cards follow the existing permission and employee-record checks.

On phones/tablets a fixed bottom bar prioritizes Home, Attendance, Tasks and Requests, with More opening the complete navigation. Items are derived from existing permissions; salary appears only when its existing conditions are met. Leave links to the existing leave-filtered request centre. No new leave endpoint or workflow was introduced.

### Public website and authentication

Marketing has its own header, native mobile menu, generous editorial spacing, navy home hero, real product imagery and conversion links. It never inherits the ERP sidebar. Home and Features show refreshed screenshots captured from the actual implemented task screen in Arabic and English using disposable sample data.

About, Features, For Companies, For Individuals, Pricing and Contact share the same typography and calm cards. Existing pricing/individual-edition availability messaging remains truthful. Login, registration and contact use an introductory column beside a focused form on larger screens, stacked on phones. Invitation acceptance uses the shared V2 authentication card. Reset mode, legal acceptance, activation and form submission behavior remain intact. The horizon mark and app icon use the supplied identity's simplified mountain direction.

## Responsive behavior

- 375px phones: single-column content, compact page headings, full-width fields, stacked data rows where the module supports them, bounded table/tab scrolling where comparison is necessary. Phone dialogs are inset, scrollable cards with reachable close/actions.
- Tablet (verified at 800px): navigation moves into the drawer; grids and filters adapt without hiding actions; Employee gets bottom navigation. Settings sections use a readable grid.
- Laptop (1024–1279px): narrower sidebar/content padding, secondary Settings navigation becomes a grid above the content.
- Desktop (verified at 1440px): full sidebar, generous content frame, two-column dashboard, readable table density.
- Navigation sits at logical inline-start and reverses with document direction. The product topbar stays visible on scrolling. Employee content reserves space for the bottom bar and safe-area insets.
- Explicit `minmax(0, 1fr)` page tracks prevent long Arabic attendance tabs from enlarging the document. Settings labels wrap inside their own cells instead of compressing into a historical horizontal strip.

## Arabic RTL and English LTR

The existing locale root sets `lang`/`dir`; no screen guesses direction. Layout rules use logical padding, borders, insets, inline sizing and grid order. Arabic sidebar/drawer start at the right, English at the left. Navigation icons precede labels naturally in each direction. Horizon/brand marks and nondirectional icons do not mirror. Existing directional icons, isolated dates/numbers/currency, translated breadcrumbs and report formatting remain in their modules. Language switching retains the existing route behavior.

## Charts and motion

Existing charts retain real API data, accessible labels/tables and company timezone/currency handling. Indigo is the primary series; lavender and mist provide supporting separation. Semantic colors communicate state only. No random multicolor KPI cards, fabricated comparisons or decorative dashboards were introduced. Print reports preserve their independent monochrome-friendly layout and hide product navigation.

Interactive transitions use 180ms. Skeleton motion is subtle and all animation/transitions are disabled by the shared reduced-motion rule. No cinematic motion or parallax is used.

## Intentionally preserved functional boundaries

No business rules, API contracts, permissions, tenant scoping, financial calculations, attendance rules, inventory ledger behavior, report generation, notification delivery or request transitions were changed. The existing API remains the authority for every action. Navigation reads the existing session to present permitted destinations; it does not grant permissions.

The native application is the existing component catalogue, not an implemented duplicate ERP. This pass refreshes its shared colors, type scale, shape and native control sizing; it does not invent missing native workflow functionality.

Inherited Phase 16 limitations remain: production mail/contact configuration is required; SMTP handoff does not prove inbox receipt; no durable contact inbox exists; password-reset requests still lack reset-email delivery; supplied legal terms content is absent; the individual edition and billing enforcement are not implemented. The seeded first administrator has no employee record, so employee-only attendance/salary surfaces can remain unavailable until the existing employee setup is completed. Those are functional/content boundaries, not deferred visual decisions.

## Browser QA and accessibility results

The definitive local browser matrix completed **492 viewport checks** (164 localized route instances × 375, 800 and 1440px) and **204 axe WCAG A/AA scans**, with **zero page-level overflow, zero non-200 route responses, zero browser page errors and zero accessibility violations**. It covered all nine marketing pages, all Admin module families and Settings sections, profile tabs, report keys, payroll run/payslip detail, and Employee attendance, tasks, goals, requests, leave-filtered requests, salary/history/payslip, monthly reports and notifications. Real disposable sample records were served by the existing loopback-only API/PostgreSQL preview fixture; this was not a fabricated dashboard.

Screenshots were inspected for Arabic Admin tasks/dashboard/Settings, English Employees, Employee home/attendance/salary, mobile registration and shared dialogs. Additional keyboard tests passed drawer Tab cycling, Escape, trigger focus restoration, navigation dismissal, locale switching with preserved destination, and shared form-dialog focus containment/restoration. Dialog and destructive-confirmation accessibility scans passed. Shared loading/error/empty states were exercised with browser-only response simulations. A real disposable department form submission verified validation, save/success and destructive-confirmation presentation without altering product contracts.

The larger matrix used the local development frontend. Production compilation and a separate production-preview smoke check are recorded below. An early long-lived browser run terminated and was replaced with isolated per-route browsers; its partial results were not used as the final matrix. Temporary browser/API fixture behavior is not a production availability measurement.

### Defects found and fixed

- Replaced the Settings historical horizontal auto-column strip with a wrapping responsive grid; fixed labels compressed into vertical columns.
- Added shrinkable page/nested-card tracks so attendance tabs and Settings data tables cannot enlarge phone pages.
- Darkened unread-notification metadata/body text on Mist Blue to meet text contrast requirements.
- Added explicit Tab cycling and focus restoration for controlled dialogs that unmount; navigation drawers retain their trigger focus on Escape.
- Prevented month identifiers from splitting across lines on phone attendance steppers.
- Corrected Settings selected navigation across its child screens and used Home in the simpler English Employee navigation.
- Replaced old green product screenshots with actual V2 captures, removed development-tool overlays from the captures and versioned their paths to avoid stale optimized imagery.

No known functional regression was introduced by the visual work. The functional limitations above are intentionally preserved.

### Production preview and onboarding

The production build additionally passed **90 viewport checks** and **12 WCAG A/AA scans** with zero violations. These covered Home, Features, Pricing, Contact, Login, Register, Admin monthly attendance/Settings/tasks, Employee home/attendance/salary, valid and invalid invitations, and localized 404s in both languages at all three widths. The real refreshed product images loaded successfully. A complete invitation acceptance flow activated a disposable account through the unchanged API. The final production preview also passed the navigation/dialog keyboard and shared loading/error/empty-state checks.

The existing unavailable page now has localized Arabic/English copy, the V2 brand frame, and usable Home/Sign in recovery actions while retaining its 404 response. No unavailable state was left as an unstyled legacy screen.

Machine-readable coverage and results are in [FINAL-UI-UX-QA.json](FINAL-UI-UX-QA.json). Sample session cookies, invitation tokens and mail contents are not included in the repository.

## Repository gate

All five required commands passed. The full suite was first run with Turborepo cache bypass; the final gate reruns affected packages and reuses unchanged successful package results. No tests or assertions were weakened.

| Command             | Result                                                        |
| ------------------- | ------------------------------------------------------------- |
| `pnpm format:check` | Pass                                                          |
| `pnpm lint`         | Pass: zero errors; four inherited seed `no-console` warnings  |
| `pnpm typecheck`    | Pass                                                          |
| `pnpm test`         | 1,835 tests passed, 89 test files, zero failures              |
| `pnpm build`        | Pass across the workspace, including the production web build |

| Package  | Test files | Tests |
| -------- | ---------: | ----: |
| API      |         41 | 1,101 |
| Database |         17 |   335 |
| Web      |         22 |   282 |
| Auth     |          5 |    44 |
| Money    |          1 |    25 |
| Config   |          1 |    24 |
| i18n     |          1 |    20 |
| Mobile   |          1 |     4 |
| Total    |         89 | 1,835 |

No ordinary visual screen, responsive variant or component decision is intentionally deferred. Business hardening remains outside this design pass. No deployment, push or Phase 17 work is part of this change.

### Preview harness lifetime

The long-running opt-in preview helper reached its unchanged 20-minute test lifetime after the browser checks completed, producing one auxiliary timeout. A fresh startup/shutdown retest of that helper passed (1 passed, 38 filtered out). This helper run is separate from the normal 1,835-test repository gate; its timeout was not hidden by changing tests or extending timeouts. The disposable API/database and production preview were stopped before the commit.
