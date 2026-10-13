# Phase 13 — Warehouse: status

Phase 13 of DOCUMENT 25: warehouses of every type, per-location stock read
from an immutable ledger, and transfers between locations as paired
movements that complete fully or not at all. ADMIN only in V1.

Phases 14 (Inventory) and 12 (Reports) were **not** started.

## Execution order (documented before implementation)

`product-documentation/25-development-roadmap.md` now records, under its rule
4 ("reordering is permitted where a genuine technical dependency argues for
it — but the reasoning must be documented before the change"), that the
phases are **executed** Phase 13 → Phase 14 → Phase 12. No phase was
renumbered and no scope changed. The reason: DOCUMENT 18's V1 company reports
include inventory, warehouse and stock movements, and Phase 12's exit
criterion is that every report reconciles with its source modules. Phases 13
and 14 build those sources.

## Decisions applied

| Question                                                  | Answer (product owner)                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products and inbound stock are Phase 14. What does 13 do? | **Schema only, no UI.** Phase 13 creates the `products` table (the subset transfers need) and the internal ledger service. There is **no** product endpoint, no product UI and no stock-in endpoint. Tests seed stock through the internal ledger. Real users can transfer only once Phase 14 brings stock in. |
| Destination average cost after a transfer                 | **Round once to 0.01, half away from zero.** Both legs carry the source's stored `average_cost`; the source average is unchanged; the destination applies DOCUMENT 17 rule 11 exactly (fractions) and rounds once, stored as DECIMAL(15,2).                                                                    |

Not decided here, and not marked decided:

- **OD-13** (valuation method) stays open. The transfer moves value at the
  source's weighted-average cost, the only method the spec defines. No
  second valuation method was introduced.
- **Negative stock.** DOCUMENT 17 rule 5 allows it "only when a company
  setting enables it". The company settings model defines no such setting,
  so none was invented: negative stock is **always refused**, by the service
  (422 `STOCK_INSUFFICIENT`) and by the database (`CHECK quantity >= 0`,
  `CHECK balance_after >= 0`).

## Database — migration `20261014000000_phase13_warehouse`

New enums `warehouse_type` (main, branch, store, production, online),
`product_status`, `stock_movement_type` (all nine DOCUMENT 06 types). New
`audit_action` values `warehouse.created`, `warehouse.updated`,
`warehouse.deactivated`, `stock.transfer_executed` (all canonical DOCUMENT 21
names).

| Table             | Notes                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `warehouses`      | Names in both languages, type, address, `is_active`, soft delete. **One stock model:** an online channel is a row of type `online`, nothing more.                              |
| `products`        | Phase 13 subset: names, `sku` (unique per company), unit, status, soft delete. Phase 14 adds the rest.                                                                         |
| `product_stock`   | The cache: `quantity DECIMAL(15,3) CHECK >= 0`, `average_cost DECIMAL(15,2) CHECK >= 0`, unique (product, warehouse).                                                          |
| `stock_movements` | The ledger: every DOCUMENT 06 column. CHECKs: quantity ≠ 0, `balance_after >= 0`, a transfer group exactly on transfer types, sign by type, `transfer_in` carries a unit cost. |

Database-enforced invariants (they hold even if the service is wrong):

- **Movements are immutable for every role, the owner included:** `UPDATE`,
  `DELETE` and `TRUNCATE` raise. `ufuq_app` has only `SELECT, INSERT` on the
  table. No function in the schema writes to it.
- **A movement chains:** `balance_after` must equal the cached balance (read
  `FOR UPDATE`) plus its quantity, and the warehouse must be active.
- **The cache equals the ledger:** `product_stock.quantity` must equal the
  sum of the pair's movements. No quantity without a movement. (The check was
  first written against the "latest" `balance_after`; movements written in
  one request share a timestamp, so it now uses the sum. An insert for a pair
  that already has a row is let through, since the unique constraint makes it
  a no-op or a refusal and `ON CONFLICT DO NOTHING` relies on it.)
- `product_stock` rows are never deleted.
- **A warehouse holding stock cannot be deactivated or soft-deleted**, and
  warehouses are never hard-deleted.
- Same-company triggers on every reference. RLS on all four tables.

## The ledger service

`StockLedgerService` (`apps/api/src/warehouse/stock-ledger.service.ts`) is
the one writer of `stock_movements` and `product_stock`. It takes the
caller's transaction and never opens one.

- `lock(tx, company, pairs)` creates any missing cache rows
  (`INSERT … ON CONFLICT DO NOTHING`) and takes `SELECT … FOR UPDATE` on each,
  **sorted by (product, warehouse)**, so concurrent writers serialize and
  overlapping writers cannot deadlock.
- `post(…)` writes each movement first, then the cache. Outbound beyond the
  locked balance is 422 `STOCK_INSUFFICIENT` (fields `product_id`,
  `warehouse_id`, `available`, `requested`).
- There is **no** method that sets a quantity, and no helper that rewrites a
  movement.

## Transfers — `POST /warehouses/transfers`

One transaction (`AuditDispatcher.withTenant`):

1. Validate: source ≠ destination, 1–100 lines, each product once, quantity
   a positive DECIMAL(15,3) string. 422 `VALIDATION_FAILED` otherwise.
2. Idempotency: replay or claim the `Idempotency-Key` with a pre-assigned
   transfer group id. The same key with a different body is 422
   `IDEMPOTENCY_KEY_REUSED`.
3. Lock both warehouses `FOR SHARE` (deactivation takes `FOR UPDATE`, so a
   location cannot be deactivated mid-transfer). Unknown or other-company:
   422 `not_found` (no tenant leakage). Inactive: 409 `WAREHOUSE_INACTIVE`.
4. Products must exist in the tenant and not be deleted.
5. Lock every (product, source) and (product, destination) cache row.
6. For each line, write **exactly two** movements sharing the
   `transfer_group_id`: `transfer_out` (−qty, unit cost = source average) and
   `transfer_in` (+qty, same unit cost). Source average unchanged;
   destination average per rule 11, rounded once.
7. Record `stock.transfer_executed` (entity `stock_transfer`, id = the group)
   with every line and **every movement id** (DOCUMENT 17 rule 14). It is
   written after commit by the dispatcher; a rollback writes nothing.

## Proofs (all in `apps/api/test/warehouse.e2e.test.ts` and `packages/db/test/phase13-rls.test.ts`)

| Claim                            | Test                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paired, one group, exact         | A two-line transfer writes four movements in one group; main fabric 120.500 → 100.250, online 10.000 → 30.250; online average (10 × 40 + 20.25 × 35) ÷ 30.25 = 36.652… → **36.65**; transfer value 758.75.                                          |
| Forced failure → nothing changed | A trigger raises on the `transfer_in` insert, **after** the `transfer_out` leg was written: 500, movement count, both balances and audit rows unchanged. A second test fails the destination cache update: same result.                             |
| Concurrency, no lost update      | Two concurrent transfers of 60 from 100.250: one 201, one 422; source ends at exactly 40.250, destination at exactly 60.000.                                                                                                                        |
| Idempotency                      | The same key sent twice at once: one transfer (two movements), both responses carry the same group id. Reused key, different quantity: 422 `IDEMPOTENCY_KEY_REUSED`.                                                                                |
| Insufficient stock               | 200 requested of 100.250: 422 `STOCK_INSUFFICIENT` with `available` / `requested`; the earlier line of the same request was not applied.                                                                                                            |
| Validation                       | Same location, zero, four decimals, numeric (not string) quantity, duplicate product, unknown product, other-company product, other-company and unknown warehouse, unknown fields, empty lines: all 422, nothing written.                           |
| No quantity editing anywhere     | `PATCH /products/{id}/quantity` → 404; `quantity` on a warehouse PATCH → 422; `POST /stock-movements` → 404; a direct `UPDATE product_stock SET quantity` → refused ("does not match the ledger").                                                  |
| Immutability                     | `UPDATE`/`DELETE` on `stock_movements`: permission denied for `ufuq_app`, "immutable" for the owner; `TRUNCATE` refused (DB test); no `pg_proc` function writes stock tables.                                                                       |
| Cache = ledger                   | After every scenario, each `product_stock.quantity` equals Σ its movements.                                                                                                                                                                         |
| Deactivation                     | With stock: 409 `WAREHOUSE_HAS_STOCK`. Emptied by transfer: 200, audited `warehouse.deactivated`; then transfers to it are 409 `WAREHOUSE_INACTIVE`; its history stays readable; reactivation works.                                                |
| Tenant / RLS                     | Other-company location: GET, PATCH, `/stock` → 404; its warehouse or product in a transfer → 422 `not_found`; company B's dashboard shows 0 units. DB tests: each of the four tables is invisible across tenants; cross-company references refused. |
| Access                           | 401 without a session; MANAGER and EMPLOYEE get 403 on every warehouse and stock endpoint, reads and writes.                                                                                                                                        |

## Access

ADMIN only (DOCUMENT 17 "Users", DOCUMENT 08 §4.11 permissions):
`warehouse.view`, `warehouse.manage`, `stock.view`, `stock.transfer`.
MANAGER and EMPLOYEE hold none of them; enforcement is server-side.

## Audit

Through the existing post-commit `AuditDispatcher` only; no feature code
writes `AuditService`. Canonical DOCUMENT 21 actions, none invented:
`warehouse.created`, `warehouse.updated` (old/new of only the changed
fields), `warehouse.deactivated`, `stock.transfer_executed`.

## API

| Method | Path                              | Permission                                   |
| ------ | --------------------------------- | -------------------------------------------- |
| GET    | `/warehouses`                     | warehouse.view (type, is_active, pagination) |
| POST   | `/warehouses`                     | warehouse.manage                             |
| GET    | `/warehouses/dashboard`           | warehouse.view                               |
| GET    | `/warehouses/transfers`           | stock.view — **added in Phase 13**           |
| POST   | `/warehouses/transfers`           | stock.transfer · Idempotency-Key             |
| GET    | `/warehouses/transfers/{groupId}` | stock.view — **added in Phase 13**           |
| GET    | `/warehouses/{id}`                | warehouse.view                               |
| PATCH  | `/warehouses/{id}`                | warehouse.manage (incl. `is_active`)         |
| GET    | `/warehouses/{id}/stock`          | stock.view — read only                       |
| GET    | `/stock-movements`                | stock.view — read only; POST is Phase 14     |

DOCUMENT 08 §4.11 was amended with the two added read-only endpoints and the
transfer's error contract. New error codes: `WAREHOUSE_HAS_STOCK` (409),
`WAREHOUSE_INACTIVE` (409), `STOCK_INSUFFICIENT` (422), in both languages.

## Web

`/admin/warehouse` (overview), `/admin/warehouse/locations`,
`/admin/warehouse/locations/{id}`, `/admin/warehouse/transfers`, plus a
warehouse summary card on the admin dashboard.

- Location list: add / edit (names in both languages, type, address) and
  deactivate / activate with the server's refusal explained.
- Location detail: figures, its stock (read only), its paginated movement
  ledger, "transfer from here".
- Transfers: list, and the transfer dialog. Products come from what the
  source holds, with the available quantity under each line. Quantities are
  checked for shape and against availability as scaled integers, never as
  floating point. One Idempotency-Key per dialog.
- There is no form, field or request anywhere in the web app that sets a
  quantity.
- Loading, empty, error and success states on every screen; RTL and LTR.
- DOCUMENT 22: desktop tables; tablet (640–1023px) tables scroll sideways
  inside their own box with the first column frozen; phones show stacked
  cards; the transfer lines stack on a phone.

Browser check against a local stack (production build, real API, seeded
data), Arabic and English, at 1280, 800 and 375px: **no page-level
horizontal overflow** on any of the four screens; at 800px every table
scrolls inside its container with a sticky first column. A transfer was made
through the dialog on a 375px viewport: the client check refused 99999 ("more
than the source holds", 990.25 available), then 25.5 m was transferred and
the stock showed 964.75. Deactivating the main warehouse showed the
`WAREHOUSE_HAS_STOCK` sentence. A location was added through the form, after
the empty form named its three required fields.

The check found one defect, fixed before commit: at 1024px the
inventory-value KPI (a no-wrap amount) widened the page by 5px. KPI figures
now wrap inside their card.

## Deferred to Phase 14 (known dependencies)

- **Products and stock-in.** The product catalogue, every product endpoint,
  `POST /stock-movements` and every inbound movement type (purchase, return,
  manual addition, adjustment) are Phase 14. Until then, a real company has
  no way to bring stock in, so it can create locations but has nothing to
  transfer. The screens say so ("products and stock receipts arrive with the
  product catalogue").
- **Dashboard elements needing the catalogue** (DOCUMENT 04 B19): total
  products, low-stock count, out-of-stock count, and the low-stock table all
  need each product's minimum stock level. The API returns them in
  `deferred: ["total_products", "low_stock_count", "out_of_stock_count",
"low_stock_table"]` and the overview explains it rather than showing a
  number it cannot know. Shown now: locations (total / active), products in
  stock, units, inventory value at average cost, stock by location, recent
  movements, 30-day movement trend.
- Negative stock as a company setting (rule 5), if the product owner adds
  one.
- OD-13 (valuation method).

## [DECISION REQUIRED]

None open for Phase 13. The two raised during the phase were answered (see
"Decisions applied"). The negative-stock setting and OD-13 are recorded above
as not decided rather than as decisions.

## Verification results

| Check                     | Result                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| `prettier --check .`      | clean                                                             |
| `turbo run lint`          | 0 errors (4 existing `no-console` warnings in the db seed script) |
| `turbo run typecheck`     | clean                                                             |
| `turbo run test --force`  | **1514 tests**, all passing                                       |
| `turbo run build --force` | 8 / 8                                                             |

| Package        | Tests | Phase 13 additions                                                         |
| -------------- | ----- | -------------------------------------------------------------------------- |
| `packages/db`  | 299   | **+18** — `test/phase13-rls.test.ts`                                       |
| `apps/api`     | 863   | **+33** — `warehouse-rules.test.ts` (9), `test/warehouse.e2e.test.ts` (24) |
| `apps/web`     | 239   | **+15** — `lib/warehouse.test.ts`                                          |
| other packages | 113   | unchanged (config 20, money 25, i18n 20, auth 44, mobile 4)                |
