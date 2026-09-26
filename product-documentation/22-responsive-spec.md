# DOCUMENT 22 — RESPONSIVE DESIGN SPECIFICATION

## PRINCIPLE

**Do not shrink the desktop UI.** Each breakpoint gets the layout appropriate to its context and its user's task. A payroll run and a check-in are different jobs on different devices and deserve different designs.

## BREAKPOINTS

| Name | Range | Primary user |
|---|---|---|
| Mobile | 320–639px | Employee |
| Tablet | 640–1023px | Employee, occasional manager |
| Laptop | 1024–1439px | Admin, manager |
| Desktop | 1440px+ | Admin |

## DEVICE PRIORITY BY MODULE

| Module | Mobile | Tablet | Desktop |
|---|---|---|---|
| Employee attendance | **Primary** | Full | Full |
| Employee tasks | **Primary** | Full | Full |
| Employee requests & leave | **Primary** | Full | Full |
| Employee salary view | **Primary** | Full | Full |
| Notifications | **Primary** | Full | Full |
| Admin dashboard | Usable | Good | **Primary** |
| Employee management | Usable | Good | **Primary** |
| Attendance management | Usable | Good | **Primary** |
| Task management (admin) | Usable | Good | **Primary** |
| Payroll | Limited by design | Good | **Primary** |
| Reports | Usable | Good | **Primary** |
| Warehouse & inventory | Limited | Good | **Primary** |
| Settings | Limited | Good | **Primary** |

"Limited by design" is deliberate: **payroll finalization is not available on mobile.** An irreversible financial action should not be one mis-tap away on a phone.

## LAYOUT BEHAVIOUR

### Navigation
| Breakpoint | Admin | Employee |
|---|---|---|
| Mobile | Hamburger → full-screen drawer | Bottom tab bar (5 items) + drawer for the rest |
| Tablet | Collapsed icon sidebar, expandable | Collapsed icon sidebar |
| Laptop | Collapsed by default, expandable | Expanded |
| Desktop | Expanded (248px) | Expanded |

The bottom tab bar in RTL orders items right to left.

### Tables → cards
Below 1024px, data tables become stacked cards.

```
Desktop row:  [avatar name] [dept] [position] [status] [date] [⋮]

Mobile card:  ┌─────────────────────────────┐
              │ [avatar]  أحمد محمد    [نشط] │
              │ التسويق · مصمم جرافيك        │
              │ انضم ١٥ يناير ٢٠٢٦      [⋮] │
              └─────────────────────────────┘
```

The card shows the 3–4 fields that matter for scanning. The rest live in the detail view. **Do not** render a 9-column table as a 9-line card — that is shrinking, not designing.

### Exceptions where cards are wrong
The attendance monthly matrix and the payroll run table lose their meaning as cards. On mobile:
- **Monthly matrix** → one employee at a time, month calendar view.
- **Payroll run** → summary card list; the full breakdown opens per employee.

### Filters
Desktop: inline filter bar.
Tablet: inline, wrapping to a second row.
Mobile: a filter button showing the active count, opening a bottom sheet with an apply action.

### Forms
Desktop: two columns for related short field pairs.
Tablet and below: single column.
Mobile: sections become an accordion, with a sticky submit bar at the foot.

### Charts
Desktop: side by side in a grid.
Tablet: two per row, then one.
Mobile: full width, stacked, with reduced label density and a horizontal scroll for time series rather than an unreadable compression.

### Modals
Desktop: centred, max 560px.
Tablet: centred, 90% width.
Mobile: full-screen sheet sliding from the bottom, with a close button in the header.

## TOUCH TARGETS
Minimum 44×44px on touch devices. Primary employee actions (check in, check out) are minimum 56px tall. Spacing between adjacent targets is at least 8px. Hover-only interactions always have a tap equivalent.

## MOBILE-SPECIFIC BEHAVIOUR
- Native date, time, and file pickers.
- Camera access for attachments.
- Pull to refresh on lists.
- Optimistic UI on the check-in action, with rollback on failure.
- No horizontal page scroll, ever — only intentional horizontal scroll inside a scoped container.
- The check-in flow must complete on a slow connection.

## TYPOGRAPHY & SPACING SCALING

| Token | Desktop | Mobile |
|---|---|---|
| `h1` | 30px | 24px |
| `h2` | 24px | 20px |
| `body` | 15px | 15px |
| `kpi` | 32px | 26px |
| Page padding | 32px | 16px |
| Card padding | 20px | 16px |
| Section gap | 32px | 24px |

Body text does not shrink below 15px. Small text on mobile is a readability failure, not a space saving.

## RTL AND RESPONSIVENESS TOGETHER
Every breakpoint is tested in both directions. Drawers slide from the correct edge, bottom tab order mirrors, swipe gestures mirror, and horizontal scroll starts at the correct end. RTL is not verified only on the desktop login screen.

## TESTING MATRIX
| Device class | Reference |
|---|---|
| Small phone | 360×640 |
| Standard phone | 390×844 |
| Large phone | 430×932 |
| Tablet portrait | 768×1024 |
| Tablet landscape | 1024×768 |
| Laptop | 1440×900 |
| Desktop | 1920×1080 |

Each tested in Arabic RTL and English LTR. Fourteen combinations, on every screen that reaches "done".
