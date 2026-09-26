# DOCUMENT 11 — UI/UX SPECIFICATION

## 1. UX principles

These fifteen principles are binding. Any screen that violates one needs a documented reason.

1. **Reduce unnecessary clicks.** Attendance check-in is one tap. Approving a request from the dashboard is one tap. Creating a task is one screen, not a wizard.
2. **Make important information visible immediately.** No key figure hides behind a tab or an accordion on a dashboard.
3. **Use clear status indicators.** Every record with a lifecycle shows a status chip in the same position across modules.
4. **Keep financial information understandable.** Payslips show the arithmetic, not just the result. Every deduction shows its reason.
5. **Make attendance extremely fast.** The employee dashboard opens with the attendance action above the fold. Two taps maximum from app open to checked in.
6. **Make employee tasks easy to understand.** A task shows what to do, when it's due, and how far along it is, without scrolling.
7. **Make management dashboards dense but not cluttered.** Grouped, aligned, and consistently sized — density comes from good grouping, not from cramming.
8. **Use consistent patterns across modules.** Lists behave identically everywhere. Detail pages share one structure. Approval flows look the same in every module.
9. **Confirm destructive actions.** Naming the object in the confirmation, and requiring typed confirmation for irreversible financial actions.
10. **Preserve user input when validation fails.** A failed save never clears a form. This is non-negotiable.
11. **Show loading states.** Skeletons that match the final layout.
12. **Show empty states.** Distinguishing truly-empty from filtered-empty.
13. **Show error states.** With a cause and a next step, never a bare failure message.
14. **Show success states.** A toast plus a visible change in the data.
15. **Show permission restrictions appropriately.** Hide what the user can never do; explain what they cannot do *yet* or *here*.

## 2. The four mandatory states

Every screen implements all four. A screen missing any of them is incomplete and must not be marked done.

### Loading
- Skeletons matching the real layout, sized to the expected content.
- Independent loading per dashboard widget. One slow widget never blocks the page.
- Actions within a loaded page use inline spinners, not page-level loaders.
- Never a full-page spinner on a page the user has already seen.

### Empty
- Truly empty: explanation plus the primary action that resolves it.
- Filtered empty: explanation plus a clear-filters action.
- New-company empty: an onboarding checklist rather than a wall of zero-value widgets.

### Error
- Says what failed, in plain language, in the user's locale.
- Offers a next step: retry, adjust filters, contact administrator.
- Preserves context — filters stay applied, form input stays entered.
- Never exposes stack traces, SQL, internal identifiers, or file paths.
- Per-widget errors on dashboards, not a whole-page failure.

### Success
- Toast confirmation naming what happened.
- The underlying data visibly updates.
- For multi-step flows, the user lands somewhere useful, not back at a blank list.

## 3. Feedback timing

| Duration | Treatment |
|---|---|
| < 300ms | No indicator |
| 300ms – 1s | Inline spinner on the triggering control |
| 1s – 5s | Skeleton or progress indicator |
| > 5s | Progress with an explanatory message, e.g. "generating payroll for 48 employees" |
| Background jobs | Toast on completion plus a notification |

## 4. Form design

- One column by default. Two columns only for short, closely-related pairs such as start and end date.
- Fields grouped into labelled sections with a `space-6` gap between them.
- Labels above fields, always visible.
- Helper text below the field, before any error message.
- Validation on blur for format rules, on submit for cross-field rules.
- Errors summarised at the top of long forms with anchor links to each field.
- The submit action is sticky at the bottom on mobile and long forms.
- Unsaved-changes warning when navigating away from a dirty form.
- Required fields marked with an asterisk and announced to assistive technology.
- Optional fields are labelled "(اختياري)" when most fields in a form are required.

## 5. Data density

| Context | Density |
|---|---|
| Admin tables | Comfortable — 52px rows |
| Admin dashboard | Dense but grouped |
| Employee screens | Generous — larger targets, more whitespace |
| Mobile | Generous everywhere; minimum 44px touch targets |

A compact table mode (40px rows) is offered as a user preference for power users on large datasets.

## 6. Interaction patterns

**Lists:** filter bar above, results below, pagination at the foot. Filters persist in the URL so a filtered view is shareable and survives refresh.

**Detail pages:** header with identity and primary actions · tabs or sections · activity or audit strip at the foot.

**Approval flows:** identical everywhere — context panel, decision buttons, mandatory reason for rejection, confirmation, notification.

**Inline editing:** used only for single low-risk fields such as a task's priority. Never for financial values.

**Bulk actions:** selection checkboxes, a floating action bar, and a confirmation naming the count. Not in V1 scope except where DOCUMENT 24 states otherwise.

## 7. Notification and badge behaviour

- Unread count on the bell, capped at "99+".
- Notifications are grouped by day.
- Tapping a notification navigates to the source record and marks it read.
- Approval notifications are actionable inline where safe.
- Badge counts refresh on navigation and on a polling interval, not on every keystroke.

## 8. Search and filtering

- Search inputs debounce at 300ms.
- Search scope is stated in the placeholder, e.g. "ابحث بالاسم أو الرقم الوظيفي".
- Filters show an active count, and a single clear-all action.
- Applied filters render as removable chips above the results.
- Empty search results explain what was searched and offer to clear.

## 9. Dates, times, numbers, currency

| Item | Rule |
|---|---|
| Dates | Gregorian by default, Hijri display optional per company. Format `DD MMM YYYY` in Arabic, `DD MMM YYYY` in English |
| Relative dates | "اليوم", "أمس", "منذ ٣ أيام" for recent items; absolute beyond 7 days |
| Times | 12-hour with ص/م in Arabic, 12-hour with AM/PM in English. Configurable to 24-hour |
| Timezone | Always the company timezone, never the browser's |
| Numbers | Thousands separators, tabular figures in tables |
| Currency | Amount then currency symbol per locale convention: `20,000 ج.م` |
| Percentages | One decimal place maximum |
| Durations | `8h 05m` / `٨س ٠٥د` |

## 10. Accessibility

- Minimum 4.5:1 contrast for body text, 3:1 for large text and interactive borders.
- Every interactive element reachable and operable by keyboard.
- Visible focus rings using `shadow-focus`. Never `outline: none` without a replacement.
- Semantic HTML: real buttons, real headings in order, real tables for tabular data.
- Form labels programmatically associated with their controls.
- Live regions announce toasts, validation summaries, and async completions.
- Colour is never the sole carrier of meaning — status chips always include text.
- Charts have an accessible text summary and a table alternative.
- `lang` and `dir` set correctly and updated when the language changes.

## 11. Error message style

| Bad | Good |
|---|---|
| "Error 500" | "تعذر حفظ البيانات. حاول مرة أخرى." |
| "Invalid input" | "تاريخ النهاية يجب أن يكون بعد تاريخ البداية." |
| "Unauthorized" | "لا تملك صلاحية اعتماد كشوف الرواتب. تواصل مع المدير." |
| "Failed" | "لا يمكن تسجيل الحضور لأنك سجلت حضورك بالفعل في ٠٨:٥٧ ص." |

Rules: state what happened · state why · state what to do next · never blame the user · never expose internals.

## 12. Copy tone

Arabic is formal but not stiff — the register of professional business software, not government forms. Address the user directly. Prefer verbs over nouns in actions ("إضافة موظف", not "إضافة موظف جديد إلى النظام").

Terminology is fixed and consistent across the product. A glossary is maintained: الحضور والانصراف, الطلبات, الرواتب, المخزن, المخزون, الأهداف, المهام. The same term never appears in two variants across screens.

## 13. Onboarding

A new company's first session shows a checklist on the dashboard:
1. Complete company profile
2. Add departments
3. Set the working schedule
4. Configure leave types
5. Add employees
6. Send invitations

Each item links to the relevant screen and marks itself complete. The checklist disappears once all items are done and does not return.

New employees see a one-time highlight of the attendance action on their first login. No multi-screen tour.

## 14. Anti-patterns

Explicitly forbidden:
- Infinite scroll on data tables — use pagination.
- Modals inside modals.
- Toasts as the only feedback for a destructive action.
- Disabled buttons with no explanation of why.
- Placeholder-only labels.
- Clearing forms on validation error.
- Progress that jumps backwards.
- Full-page spinners on already-loaded pages.
- Icon-only buttons without a tooltip or accessible label.
- Different words for the same concept in different modules.
