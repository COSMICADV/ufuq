# DOCUMENT 10 — DESIGN SYSTEM

The attached reference is the **visual source of truth**. Every value below is derived from it. Do not substitute a generic blue enterprise palette. Do not introduce colours that are not in this document.

---

## 1. Colour system

### 1.1 Brand — Deep green
The identity colour. Sidebar, brand surfaces, headings, footers.

| Token | Hex | Use |
|---|---|---|
| `--green-deep-900` | `#1B2E12` | Deepest brand surface, logo mark |
| `--green-deep-800` | `#243C18` | **Sidebar background** — the signature surface |
| `--green-deep-700` | `#2A3E1F` | Sidebar hover, footer band |
| `--green-deep-600` | `#304824` | Elevated dark surfaces |

### 1.2 Primary — Bright green
Actions and positive states only. Used sparingly.

| Token | Hex | Use |
|---|---|---|
| `--green-primary-700` | `#2C5716` | Primary button pressed |
| `--green-primary-600` | `#38681B` | **Primary button, active nav pill** |
| `--green-primary-500` | `#41702B` | Primary hover, chart series 1 |
| `--green-primary-400` | `#5C8A3E` | Progress fill, positive delta text |

### 1.3 Olive & sage — Secondary surfaces and charts

| Token | Hex | Use |
|---|---|---|
| `--olive-600` | `#6C7C48` | Chart series 2, secondary emphasis |
| `--olive-500` | `#809860` | Chart series 3, donut segment |
| `--sage-400` | `#A8B894` | Chart series 4, muted illustration |
| `--sage-300` | `#C8D0B0` | Chart fills, illustration mid-tone |
| `--sage-200` | `#D8E4CC` | **Success chip background**, chart area fill |
| `--sage-100` | `#E8EEDF` | Subtle tinted surface |

### 1.4 Gold & brown — Supporting accents

| Token | Hex | Use |
|---|---|---|
| `--gold-600` | `#886840` | Warning text, accent icon |
| `--gold-500` | `#907048` | Warning border |
| `--gold-300` | `#D8C49A` | Warning chip border |
| `--gold-100` | `#FDF2BC` | **Warning chip background**, highlight |
| `--brown-700` | `#483828` | Deep accent, illustration shadow |
| `--brown-600` | `#584838` | Illustration, tertiary text on light |

### 1.5 Neutrals — Warm, never grey-blue

| Token | Hex | Use |
|---|---|---|
| `--bg-page` | `#FAF5EE` | **Page background** — warm cream |
| `--bg-surface` | `#FCF7F2` | Card and panel surface |
| `--bg-surface-raised` | `#FEFAF6` | Modal, dropdown, elevated card |
| `--border-subtle` | `#EDE5DA` | Card border, divider |
| `--border-default` | `#DDD3C6` | Input border, table border |
| `--border-strong` | `#C4B8A8` | Input focus ring base, emphasis divider |
| `--text-primary` | `#241F1A` | Body and heading text |
| `--text-secondary` | `#5C5348` | Labels, secondary text |
| `--text-tertiary` | `#8A8175` | Placeholders, metadata, disabled |
| `--text-on-dark` | `#FAF1E7` | Text on deep green |
| `--text-on-dark-muted` | `#C0C8B4` | Secondary text on deep green |

**Rule:** neutrals are warm (cream/taupe). Never use pure `#FFFFFF` for surfaces or `#F5F5F5` cool greys. The warmth is part of the brand.

### 1.6 Semantic colours

| Meaning | Text | Background | Border |
|---|---|---|---|
| Success / Paid / Present | `#2C5716` | `#D8E4CC` | `#B8CCA4` |
| Warning / Pending / Late | `#7A5A2E` | `#FDF2BC` | `#E4D0A0` |
| Danger / Overdue / Absent | `#8C2F1E` | `#F6DDD6` | `#E0B4A8` |
| Info / Draft / Neutral | `#4A5240` | `#E8EEDF` | `#CDD6C0` |
| WFH | `#4A5A6E` | `#DFE6EE` | `#BECAD8` |
| Office | `#2C5716` | `#D8E4CC` | `#B8CCA4` |

Danger red is the **only** hue outside the green/gold/brown family. It is muted and desaturated so it belongs to the palette rather than shouting over it. It is used for destructive actions and error states only.

### 1.7 Chart palette (in order)

```
1  #38681B   primary green
2  #6C7C48   olive
3  #809860   light olive
4  #A8B894   sage
5  #886840   gold-brown
6  #C8D0B0   pale sage
7  #584838   brown
8  #D8E4CC   very pale sage
```

Series must be distinguishable in greyscale. Never rely on colour alone — always pair with a legend, direct label, or pattern.

### 1.8 Usage discipline

| Do | Don't |
|---|---|
| Deep green for identity surfaces | Deep green for large content areas |
| Bright green for primary actions, active nav, progress, positive states | Bright green for decorative fills or multiple competing buttons |
| Sage and olive for charts and secondary surfaces | Sage as body text colour (contrast fails) |
| Gold and brown as accents | Gold as a primary action colour |
| Warm cream backgrounds | Pure white or cool grey |

**One primary green button per view region.** If a screen has three green buttons, two are wrong.

---

## 2. Typography

### 2.1 Families

| Role | Arabic | English | Fallback |
|---|---|---|---|
| UI + headings | IBM Plex Sans Arabic | Inter | system-ui, sans-serif |
| Numerals & tabular data | IBM Plex Sans Arabic (tabular figures) | Inter (tabular figures) | monospace fallback |

Arabic is the primary script. The Latin face must be chosen to sit comfortably beside it in x-height and weight, not the other way round.

If a licensed alternative is preferred, Noto Sans Arabic or Cairo are acceptable substitutes. Do not mix more than two families.

### 2.2 Scale

| Token | Size | Line height | Weight | Use |
|---|---|---|---|---|
| `display` | 40px | 1.2 | 700 | Marketing hero only |
| `h1` | 30px | 1.3 | 700 | Page title |
| `h2` | 24px | 1.35 | 600 | Section heading |
| `h3` | 20px | 1.4 | 600 | Card title |
| `h4` | 17px | 1.45 | 600 | Sub-section |
| `body-lg` | 16px | 1.6 | 400 | Emphasis body |
| `body` | 15px | 1.6 | 400 | Default body |
| `body-sm` | 13px | 1.55 | 400 | Table cells, secondary |
| `caption` | 12px | 1.5 | 500 | Labels, metadata |
| `kpi` | 32px | 1.15 | 700 | KPI card values |
| `kpi-sm` | 24px | 1.2 | 700 | Compact KPI |

Arabic text needs slightly more line height than Latin. Never set Arabic below 1.5.

### 2.3 Numerals

Latin numerals (0–9) by default in both locales — this is the convention in Egyptian business software. Arabic-Indic numerals available as a company setting. All tabular numbers use tabular figures so columns align.

---

## 3. Spacing

Base unit **4px**.

| Token | Value | Use |
|---|---|---|
| `space-1` | 4px | Icon-to-text gap |
| `space-2` | 8px | Tight internal padding |
| `space-3` | 12px | Chip padding, compact rows |
| `space-4` | 16px | Default card padding, form field gap |
| `space-5` | 20px | Card padding (comfortable) |
| `space-6` | 24px | Section gap, card gap |
| `space-8` | 32px | Major section gap |
| `space-10` | 40px | Page top padding |
| `space-12` | 48px | Large layout gap |
| `space-16` | 64px | Marketing section gap |

Layout metrics: sidebar expanded **248px**, collapsed **72px**; header height **64px**; page max content width **1440px**; page horizontal padding **32px** desktop, **16px** mobile.

---

## 4. Border radius

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 6px | Chips, badges, small inputs |
| `radius-md` | 10px | Buttons, inputs, nav pills |
| `radius-lg` | 14px | Cards, panels |
| `radius-xl` | 20px | Modals, hero panels |
| `radius-full` | 9999px | Avatars, progress bars, icon buttons |

Do not exceed `radius-xl` on content surfaces. Excessively rounded cards read as consumer app, not ERP.

---

## 5. Shadows

Warm-tinted, never neutral black.

| Token | Value | Use |
|---|---|---|
| `shadow-xs` | `0 1px 2px rgba(60, 48, 36, 0.05)` | Table row hover |
| `shadow-sm` | `0 1px 3px rgba(60, 48, 36, 0.07)` | Default card |
| `shadow-md` | `0 4px 12px rgba(60, 48, 36, 0.09)` | Dropdown, popover |
| `shadow-lg` | `0 12px 32px rgba(60, 48, 36, 0.13)` | Modal |
| `shadow-focus` | `0 0 0 3px rgba(56, 104, 27, 0.22)` | Focus ring |

Shadows carry elevation only. They are never decorative and never coloured beyond the warm tint above.

---

## 6. Components

### 6.1 Buttons

| Variant | Background | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--green-primary-600` | `#FFFFFF` | none | The one main action |
| Secondary | `--bg-surface` | `--text-primary` | `--border-default` | Supporting actions |
| Tertiary / Ghost | transparent | `--green-primary-600` | none | Low-emphasis, inline |
| Destructive | `#8C2F1E` | `#FFFFFF` | none | Delete, deactivate |
| Destructive ghost | transparent | `#8C2F1E` | `#E0B4A8` | Destructive in a menu |

Sizes: sm 32px · md 40px (default) · lg 48px.
Padding: 16px horizontal (md). Icon gap 8px. Radius `radius-md`.
States: hover darkens 8% · active darkens 14% · focus adds `shadow-focus` · disabled 40% opacity with `cursor: not-allowed` · loading shows a spinner and keeps the button width fixed to prevent layout shift.

**Rule:** one primary button per region. Destructive actions never sit adjacent to the primary action without visual separation.

### 6.2 Inputs

Height 40px (md) · padding 12px horizontal · radius `radius-md` · border `--border-default` · background `--bg-surface-raised`.

States: focus → border `--green-primary-600` + `shadow-focus` · error → border `#8C2F1E` + message below in the same colour · disabled → background `#F2ECE4`, text `--text-tertiary` · readonly → no border, background transparent.

Every input has a visible label above it. Placeholder text is never a substitute for a label. Required fields are marked with an asterisk in `#8C2F1E` and announced to assistive technology.

Variants: text, number (tabular figures, RTL-safe), textarea (min 96px, resizable vertically), select, multi-select, date picker (Gregorian, Hijri display optional), time picker, file upload (drag zone with type and size hints), toggle, checkbox, radio, search (leading icon, clear button).

### 6.3 Cards

Background `--bg-surface` · border 1px `--border-subtle` · radius `radius-lg` · padding `space-5` · shadow `shadow-sm`.

**KPI card:** label in `caption` `--text-secondary`, value in `kpi` `--text-primary`, delta chip below (green `--green-primary-500` for positive, `#8C2F1E` for negative) with the comparison period named, e.g. "‎+12% عن الشهر الماضي". Optional leading icon in a tinted circular container.

**Content card:** title row (`h3` + optional action on the opposite side), divider, body.

### 6.4 Tables

Header: background `--bg-page`, text `caption` uppercase-off, weight 600, `--text-secondary`, height 44px, bottom border `--border-default`.
Row: height 52px, bottom border `--border-subtle`, hover `--sage-100`.
Cell padding 16px horizontal. Numeric columns aligned to the line-end side with tabular figures.
Row actions live in a trailing kebab menu.
Sortable headers show a direction indicator. Sticky header on scroll. Zebra striping is **not** used — the row border is sufficient and cleaner.

Selection (where needed): leading checkbox column, selected row background `--sage-200`, and a floating bulk-action bar.

### 6.5 Badges & chips

Height 24px · padding 8px horizontal · radius `radius-sm` · `caption` weight 500 · 1px border.

| Badge | Background | Text |
|---|---|---|
| مدفوعة / Paid / Completed | `#D8E4CC` | `#2C5716` |
| قيد التحصيل / Pending / In Progress | `#FDF2BC` | `#7A5A2E` |
| متأخرة / Overdue / Absent | `#F6DDD6` | `#8C2F1E` |
| ملغاة / Cancelled | `#E8E4DE` | `#5C5348` |
| مكتب / Office | `#D8E4CC` | `#2C5716` |
| عن بُعد / WFH | `#DFE6EE` | `#4A5A6E` |
| مسودة / Draft | `#E8EEDF` | `#4A5240` |

Priority chips: Low `--sage-200` · Medium `--sage-300` · High `--gold-100` · Urgent `#F6DDD6`.

### 6.6 Modals

Overlay `rgba(27, 46, 18, 0.45)` — a deep-green scrim, not black.
Panel: `--bg-surface-raised`, radius `radius-xl`, shadow `shadow-lg`, max-width 560px (default) / 720px (wide), padding `space-6`.
Structure: title row with close button · body · footer with actions aligned to the line-end side.
Behaviour: focus trapped inside, Escape closes (unless the form is dirty, which prompts), background scroll locked, focus returns to the trigger on close.
Destructive confirmations name the object explicitly and require typed confirmation for irreversible actions such as payroll finalization.

### 6.7 Dropdowns & menus

Background `--bg-surface-raised` · radius `radius-md` · shadow `shadow-md` · min-width 180px · item height 40px · item hover `--sage-100` · destructive item text `#8C2F1E`.
Aligned to the trigger's line-start edge, flipping when the viewport requires it. Full keyboard navigation with arrow keys, Enter, and Escape.

### 6.8 Navigation — sidebar

Background `--green-deep-800` · width 248px expanded, 72px collapsed.
Logo block at the top with `space-5` padding.
Item: height 44px, radius `radius-md`, horizontal margin 12px, icon 20px, gap 12px, text `body-sm` weight 500 in `--text-on-dark-muted`.
Hover: background `--green-deep-700`, text `--text-on-dark`.
**Active: background `--green-primary-600`, text `#FFFFFF`, icon `#FFFFFF`.** This is the palette's single strongest use of bright green and it must be reserved for it.
User block pinned to the bottom: avatar, name, role, menu trigger.
Collapsed state shows icons only with tooltips on hover.

### 6.9 Header

Height 64px · background `--bg-surface` · bottom border `--border-subtle`.
Contents: page context or breadcrumb on the line-start side; search, notifications bell with unread dot in `--gold-600`, and the user menu on the line-end side.

### 6.10 Charts

Grid lines `--border-subtle`, axis labels `caption` in `--text-tertiary`. No chart borders, no 3D, no gradients beyond a single subtle area fill.

- **Line:** 2px stroke in `--green-primary-600`, area fill `--sage-200` at 40% opacity, 4px dots on hover only.
- **Bar:** radius 6px on the leading corners, 12–20px width depending on density, series colours from §1.7.
- **Donut:** 60% inner radius, 2px gap between segments, centre reserved for the total value and label.
- **Progress ring:** 6px stroke, track `--sage-200`, fill `--green-primary-600`.

Every chart requires a legend or direct labels, an accessible summary, and a data table alternative for screen readers.

### 6.11 Progress bars

Height 8px (6px compact) · radius `radius-full` · track `--sage-200` · fill `--green-primary-600`.
Optional percentage label on the line-end side. In RTL, progress fills **from the right**.
Colour by state where meaningful: on-track green, at-risk `--gold-500`, behind `#8C2F1E`.

### 6.12 Toasts

Position: bottom line-start corner. Width 360px max. Radius `radius-md`. Shadow `shadow-md`. Auto-dismiss after 5s; errors persist until dismissed.
Success: `--sage-200` background, `#2C5716` text, check icon.
Error: `#F6DDD6` background, `#8C2F1E` text, alert icon.
Warning: `#FDF2BC` background, `#7A5A2E` text.
Info: `--sage-100` background, `--text-primary` text.
Toasts are announced via an ARIA live region.

### 6.13 Alerts (inline)

Full-width banner within the content area. Left (line-start) accent border 3px in the semantic colour, tinted background, icon, title, body, optional action link. Used for persistent conditions such as "payroll for this period is finalized and cannot be edited".

### 6.14 Empty states

Centred stack: illustration or icon at 96px in `--sage-300`, `h4` title, `body-sm` explanation in `--text-secondary`, primary action button.
Vertical padding `space-12`.

**Two distinct variants, never conflated:**
- **Truly empty** — "لا يوجد موظفون بعد" with an Add employee action.
- **Filtered empty** — "لا توجد نتائج مطابقة" with a Clear filters action.

### 6.15 Loading skeletons

Background `--sage-100`, radius matching the real element, shimmer sweep of 1.4s. Text lines 12px tall with 8px gaps and varied widths (100% / 80% / 60%). Skeleton structure mirrors the real layout so nothing shifts when data arrives.

Rules: skeletons for initial load; inline spinners for actions within a loaded page; never a full-page spinner on a page the user has already seen; skeleton row count matches the expected page size.

---

## 7. Iconography

Line icons, 1.5px stroke, 20px default (16px compact, 24px prominent), rounded caps and joins. One icon set throughout — no mixing.

Directional icons (arrows, chevrons, back, next, send) **mirror in RTL**. Non-directional icons (clock, user, calendar, warning, search) do **not** mirror. A checklist of which icons mirror is maintained alongside the icon set.

---

## 8. Motion

| Interaction | Duration | Easing |
|---|---|---|
| Hover, focus | 120ms | ease-out |
| Dropdown, tooltip | 160ms | ease-out |
| Modal | 220ms | cubic-bezier(0.2, 0, 0, 1) |
| Page transition | 200ms | ease-in-out |
| Skeleton shimmer | 1400ms | linear, infinite |
| Toast | 240ms | ease-out |

Respect `prefers-reduced-motion`: disable shimmer and transforms, keep opacity changes.
Motion communicates state change. It is never decorative.

---

## 9. RTL rules

RTL is the default. LTR is the variant.

1. Use logical CSS properties throughout: `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`. Never `margin-left` / `right` in layout code.
2. `dir="rtl"` on the document root for Arabic; `dir="ltr"` for English.
3. The sidebar sits on the **right** in RTL.
4. Table columns flow right to left; numeric columns align to the line-end side.
5. Progress bars and charts fill from the right in RTL. Time-series x-axes run right to left.
6. Breadcrumb separators and directional icons mirror.
7. Numbers, SKUs, email addresses, and phone numbers remain LTR inside RTL text — wrap them with `dir="ltr"` and `unicode-bidi: isolate` to prevent bidirectional rendering bugs.
8. Test every screen in both directions. RTL is not an afterthought and must not be verified only on the login page.

---

## 10. Do and don't

**Do**
- Keep backgrounds warm and light.
- Reserve bright green for actions, active nav, progress, and positive states.
- Let deep green carry the brand through the sidebar and brand surfaces.
- Use sage and olive for chart series and secondary surfaces.
- Keep information density high but visually calm.

**Don't**
- Replace the palette with generic blue ERP colours.
- Use gradients beyond a single subtle chart area fill.
- Use glassmorphism, blur panels, or translucent cards.
- Over-round cards.
- Flood the interface with bright green.
- Build noisy dashboards with competing colours.
- Use pure black text, pure white surfaces, or cool grey borders.
