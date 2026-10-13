# Phase 14 — Inventory: status

Phase 14 of DOCUMENT 25, built on Phase 13's warehouse and ledger: the full
product catalogue, categories, suppliers, every stock movement type,
weighted-average valuation, low- and out-of-stock detection, movement
history, reconciliation and the inventory screens. ADMIN only in V1.

Phase 12 (Reports) and Phase 15 (Notifications) were **not** started.

Nothing from Phase 13 was duplicated or replaced: `warehouses`,
`product_stock`, `stock_movements`, the transfer service, its locking and
movement immutability are all reused and extended.

## Decisions applied

| Question                              | Answer                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 13 read-only transfer endpoints | **Kept** as the documented API amendment (product owner).                                                                                                                                                                            |
| OD-13 valuation method                | **Decided A — weighted average cost** (product owner). DOCUMENT 28 updated. FIFO, LIFO and lot-level valuation remain out of V1.                                                                                                     |
| Negative stock                        | **Company setting `allow_negative_stock`, default false** (product owner), on `companies` beside the other company settings, edited through `PATCH /company` and audited `settings.company_updated`. No second configuration system. |
| Category creation audit               | **New canonical action `product_category.created`** (approved; DOCUMENT 21 amended).                                                                                                                                                 |
| Reconciliation trigger and permission | **ADMIN endpoint plus a daily job** (approved): `POST /inventory/reconciliation`, gated by `stock.movement_create`, and a daily BullMQ job that rebuilds as the system actor.                                                        |
| Negative-stock "warn and continue"    | **Explicit acknowledgement** (approved): without `acknowledge_negative_stock: true` the API answers 409 `STOCK_NEGATIVE_WARNING` with the figures, and the UI asks the Admin to confirm.                                             |
| Low / out-of-stock basis              | **The product's total across locations** (approved), matching DOCUMENT 04 B22's status chip.                                                                                                                                         |

Interpretations made where the documents are silent (each documented in code):

- **`return` is inbound** (a customer return back into stock). DOCUMENT 17
  lists the type without a direction.
- **The default inbound unit cost.** When no cost is sent on a `return`,
  `manual_addition` or positive `adjustment`, the location's current average
  is used while it holds stock; otherwise the product's cost price. A
  correction or a return therefore does not move the average, and new stock
  at an empty location is valued at catalogue cost. A purchase always needs
  its cost (DOCUMENT 17 "Validation"). The cost is resolved once and **stored
  on the movement**, so history never changes when the cost price does.
- **Stock arriving at a zero or negative balance takes its own cost** as the
  average. The rule-11 formula's old term describes stock that is not there
  to value.
- **Out of stock is a total of ≤ 0.** That is `= 0` (rule 8), plus the
  negative totals the setting allows.
- **Crossings.** `low_stock` fires when the total falls from above
  `min_stock` to at or below it, while staying above zero. `out_of_stock`
  fires when it falls from above zero to zero or below. A drop straight
  through both lines fires `out_of_stock` alone. Changing `min_stock` fires
  nothing; crossings come from movements only.

## Schema — migration `20261015000000_phase14_inventory`

- `audit_action` gains `product.created`, `product.updated`,
  `product.deactivated`, `product_category.created`, `stock.movement_created`,
  `stock.reconciliation_run`, `supplier.created`, `supplier.updated`.
- `companies.allow_negative_stock BOOLEAN NOT NULL DEFAULT false`.
- New `product_categories` table (`name_ar`, `name_en`, `parent_id`) and
  `suppliers` table (`name`, `contact_person`, `phone`, `email`, `address`,
  `status`). Both have RLS and same-company triggers; a category cannot be
  its own parent.
- `products` gains `category_id`, `min_stock`, `cost_price`,
  `selling_price`, `supplier_id`, `image_path` and `description`, with
  non-negative CHECKs and same-company triggers.
- Products, categories and suppliers are **never hard-deleted** (a trigger
  for every role, plus no `DELETE` grant).
- `stock_movements` gains `sequence BIGINT GENERATED ALWAYS AS IDENTITY`,
  the exact ledger order. Movements written in one request share a
  timestamp, and a request reads its clock before it waits for its lock. The
  sequence is assigned at insert, under the row lock. Nobody can set it.
- New CHECKs on movements:
  - direction by type: inbound types positive, outbound types negative,
    `adjustment` either way;
  - a reason on `adjustment` and `damage`;
  - a unit cost on **every** inbound movement, so the average can always be
    replayed from the ledger alone.
- The insert guard now also requires an **active product**. It allows a
  negative balance **only** when the company setting is on, and **never on
  a `transfer_out`**. This replaces Phase 13's blanket non-negative CHECKs.
- `attachments.related_type` accepts `product`: the product image is an
  attachment, behind its own access policy.

Phase 13's DB tests were adjusted only where a constraint was renamed or
superseded (`balance_non_negative` → the setting-aware guard; the new
direction and inbound-cost CHECKs fire first). The behaviour they prove is
unchanged.

## Movement semantics — `POST /stock-movements`

| Type                           | Direction | Unit cost                                                                                     | Reason       |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------- | ------------ |
| `purchase`                     | in        | **required**                                                                                  | —            |
| `return`                       | in        | optional (default above)                                                                      | —            |
| `manual_addition`              | in        | optional                                                                                      | —            |
| `sale`                         | out       | refused (`not_allowed`); recorded at the location average                                     | —            |
| `damage`                       | out       | refused                                                                                       | **required** |
| `manual_removal`               | out       | refused                                                                                       | —            |
| `adjustment`                   | signed    | only if positive                                                                              | **required** |
| `transfer_in` / `transfer_out` | —         | refused: `type: use_transfer`; transfers stay on the Phase 13 service, which writes both legs | —            |

The caller sends a positive quantity and the type decides its sign; only an
adjustment is signed. `quantity ≠ 0`, with at most 3 decimals. The location
must be active (else 409 `WAREHOUSE_INACTIVE`) and the product active (else
422 `not_active`). Every reference must be in the tenant (else 422
`not_found`, never a confirmation). `Idempotency-Key` is **required** (422
`IDEMPOTENCY_KEY_REQUIRED`).

**One transaction:**

1. Lock the location `FOR SHARE`.
2. Lock the product `FOR UPDATE` and read its total.
3. Lock the balance `FOR UPDATE`.
4. Validate against that balance.
5. Append the movement with its exact `balance_after`.
6. Update the cache quantity and, for an inbound movement, the average.
7. Commit.
8. Write the audit record (`stock.movement_created`, with the balances
   before and after).
9. Publish the events (`low_stock`, `out_of_stock`, `negative_stock`).

A failure before commit leaves nothing behind. The lock order is always
products, then balances; transfers take balances only. Nothing ever waits on
a product while holding a balance, so no deadlock cycle exists.

FLOW 17: `POST /products` takes an optional `initial_stock`. It becomes a
`manual_addition` through the same path, in the product's own transaction.

## Weighted-average examples (exact; all asserted in tests)

| Step                                                                  | Calculation                                                     | Result                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| Initial 100 @ 35.00, purchase 50 @ 41.00                              | (100 × 35 + 50 × 41) ÷ 150 = 5550 ÷ 150                         | **37.00**                             |
| Then a sale, a return without a cost, damage, a removal, ±adjustments | outbound leaves the average; the return comes back at 37.00     | **37.00**                             |
| 120.75 @ 37.00, manual addition 9.25 @ 40.00                          | 4837.75 ÷ 130 = 37.2134…                                        | **37.21**                             |
| Cost price changed to 50.00; 5 added at an empty branch, no cost sent | the new cost price; earlier movements keep their own unit costs | **50.00**                             |
| Transfer 10 from main (37.21) to branch (5 @ 50)                      | (5 × 50 + 10 × 37.21) ÷ 15 = 622.10 ÷ 15 = 41.4733…             | **41.47**                             |
| Inventory value                                                       | 120 × 37.21 + 15 × 41.47 = 4465.20 + 622.05                     | **5087.25** (never the selling price) |
| Replay (unit test)                                                    | (17.5 × 40 + 2.25 × 41.37) ÷ 19.75 = 40.1560…                   | **40.16**                             |
| Two concurrent purchases of 5, at 6.00 and 8.00, on an empty balance  | either order gives (5 × 6 + 5 × 8) ÷ 10                         | **7.00**                              |

## Negative-stock setting

- **Off (default):** an outbound movement beyond the balance is 422
  `STOCK_INSUFFICIENT`, naming `available` and `requested`.
- **On:**
  - The same movement is first 409 `STOCK_NEGATIVE_WARNING`, with
    `available`, `requested` and `resulting_balance`. Nothing is written.
  - Sent again with `acknowledge_negative_stock: true`, it is recorded
    (`balance_after` −3.000 in the test), returned with
    `negative_stock: true`, and audited with `negative_stock: true`.
  - It publishes `negative_stock`, plus `out_of_stock` if the total crossed
    zero.
  - A transfer is still refused.
  - Stock arriving at the negative balance takes its own cost.
- **Off again:** blocked again.
- The database checks the setting at insert time, independently of the
  service. Company B's setting is not company A's.

## Proofs

| Claim                               | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Immutability**                    | DB: `UPDATE` / `DELETE` on `stock_movements` are permission-denied for `ufuq_app` and "immutable" for the owner; `TRUNCATE` is refused (Phase 13). API: `PATCH` and `DELETE /stock-movements/{id}` are 404, `PATCH /products/{id}/quantity` is 404, and a `quantity` field on a product create or edit is 422. Services: `StockMovementService` has only `apply`, `create`, `get`; `StockLedgerService` has only `lock`, `lockProducts`, `post`. Asserted by reflection; there is no rewrite helper. UI: no edit or delete control on any ledger screen (browser check). |
| **No direct quantity write**        | The DB refuses a cache quantity that does not equal Σ movements (Phase 13 trigger, plus a Phase 14 test with a stale write). No product request has a quantity.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Atomicity**                       | Forced failure **at the movement insert**, **after the movement insert at the cache update**, and **during the valuation update** (average-cost change): each returns 500 and leaves the movement count, every cache row and the audit count unchanged, with no event. A failure writing a new product's initial stock leaves the product uncreated as well.                                                                                                                                                                                                             |
| **Audit failure after commit**      | With the audit table failing, the movement stays committed and its entry goes to the retry queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Concurrency**                     | Two concurrent sales of 7 against 10 give one 201 and one 422, leaving exactly 3. Five concurrent sales of 1 against 3 give exactly three successes, leaving 0. Two concurrent purchases both land, with the exact average. A concurrent purchase plus a sale ends in exactly one of the two serial outcomes. Cache equals ledger afterwards.                                                                                                                                                                                                                            |
| **No lost update, in the database** | A movement computed from a stale balance is refused (`balance_after` does not follow the balance), and the stale cache value cannot be written either (`phase14-rls.test.ts`).                                                                                                                                                                                                                                                                                                                                                                                           |
| **Idempotency**                     | The same key twice at once gives one movement and the same id; a later replay returns that id; the same key with a different body is 422 `IDEMPOTENCY_KEY_REUSED`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Reconciliation**                  | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Tenant / RLS**                    | DB: `product_categories` and `suppliers` are invisible across companies; cross-company references to a category, supplier or parent are refused. API: another company's product, supplier or category is 404 or `not_found`; reconciliation run by company B does not touch company A's deliberately corrupted cache.                                                                                                                                                                                                                                                    |
| **Access**                          | 401 without a session. MANAGER and EMPLOYEE get 403 on every inventory read and write, including reconciliation and movement creation; a manager also gets 404 for a product image.                                                                                                                                                                                                                                                                                                                                                                                      |

**Concurrency caveat.** The test database (PGlite) serves one connection,
so concurrent requests reach it one transaction at a time. The tests prove
the end-to-end outcome. The guarantee that holds under true parallelism is
the row locks plus the database's chain check: even a writer that read a
stale balance cannot commit. A real-PostgreSQL parallel test was not
possible here (no Docker or PostgreSQL on this machine).

## Reconciliation proof

`ReconciliationService` (`apps/api/src/inventory/reconciliation.service.ts`)
reconciles each product in its own short transaction:

1. Lock the product row.
2. For each (product, location): lock the balance row `FOR UPDATE`, then
   read that pair's movements in `sequence` order.
3. Replay them (`replay()`): the quantity is the sum; the average follows
   rule 11 at the recorded costs. Each stored `balance_after` is checked
   against the running balance; a break is reported, never rewritten.
4. Compare with the cache. In `rebuild` mode, write the rebuilt values back
   through the database's cache-equals-ledger check. A missing cache row is
   recreated.

Every run is audited `stock.reconciliation_run` with its mode, counts and
each mismatch (before and after). A run that finds a mismatch publishes
`stock_reconciliation_mismatch`.

The deliberate-corruption test (`test/inventory.e2e.test.ts`):

1. Valid history, then a check: zero mismatches, and the run is audited.
2. Corrupt the cache:
   - main: quantity 999 and average 1.00, using the owner's capability (the
     ledger trigger is disabled for the write, then re-enabled);
   - branch: average 99.99, through the ordinary app role. The average is
     not trigger-guarded, which is exactly why reconciliation exists.
3. A check reports **both** mismatches with the cached and ledger values,
   repairs nothing (the cache is still wrong), and raises the alert.
4. A rebuild repairs 2. Both balances equal their pre-corruption values
   exactly, and every cache row equals Σ its movements.
5. A second rebuild finds nothing (idempotent).
6. The daily `ReconciliationRunner.runAll()` repairs a further corruption in
   company A, finds nothing in company B, and is audited under company A's
   **system actor**.

## Alerts

`GET /inventory/alerts` (optional `type=low_stock|out_of_stock`) lists
active products by total, lowest first. The warehouse dashboard now shows
total products, low-stock and out-of-stock counts, and the low-stock table;
its `deferred` list is empty.

Crossing test on a product with `min_stock` 10:

| Change   | Event              |
| -------- | ------------------ |
| 15 → 9   | `low_stock`        |
| 9 → 8    | none (still below) |
| 8 → 13   | none (recovered)   |
| 13 → 10  | `low_stock` again  |
| 10 → 0   | `out_of_stock`     |
| 0 → 4    | none               |
| transfer | none (net zero)    |

Events go to the deferred sink (`INVENTORY_EVENT_SINK`), the Phase 15 seam.
No notification is delivered yet.

## API

New:

- `GET` / `POST /products`
- `GET` / `PATCH /products/{id}`
- `GET /products/{id}/stock`
- `GET /products/{id}/movements`
- `GET` / `POST /product-categories`
- `GET` / `POST /suppliers`
- `POST /stock-movements`
- `GET /inventory/alerts`

Added (DOCUMENT 08 §4.11 amended):

- `GET` / `PATCH /suppliers/{id}`
- `GET /stock-movements/{id}`
- `POST /inventory/reconciliation`

`GET /products` supports filters (category, supplier, location, product
status, stock status), search (name, SKU), a whitelisted sort (name, SKU,
creation, total quantity; an unknown sort is 422) and pagination. Permissions
are DOCUMENT 17's: `product.view`, `product.create`, `product.update`,
`stock.view`, `stock.movement_create`, `stock.transfer`. Creating a product
with initial stock also needs `stock.movement_create`.

## Web

Screens:

- `/admin/inventory` — list with image, name, SKU, category, unit, total,
  minimum, status chip, cost and price; filters, search, sort and
  pagination. The filter controls stay put while results reload.
- `/admin/inventory/new` — FLOW 17, including the optional initial stock and
  an inline "new category" dialog.
- `/admin/inventory/:id` — header, details, pricing and valuation, stock by
  location, recent movements. Actions: record a movement, edit (no quantity
  field), upload image, deactivate/activate.
- `/admin/inventory/:id/movements` and `/admin/inventory/movements` — the
  read-only ledger with filters. The all-products ledger carries the ledger
  check and rebuild panel.
- `/admin/inventory/suppliers` — list, search, add, edit, activate and
  deactivate.

The warehouse dashboard and the admin dashboard card show the new KPIs. The
company settings screen has the negative-stock toggle.

The movement dialog asks for a unit cost only on inbound types (required on
a purchase), a reason on adjustment and damage, and a direction for an
adjustment. It runs the warn-then-confirm negative-stock flow and uses one
Idempotency-Key per attempt.

**Browser check** (production build, real API, seeded data):

- Arabic and English at 1280, 800 and 375px, on the six inventory screens,
  the warehouse dashboard and company settings: **no page-level horizontal
  overflow** on any of the 48 combinations. At 800px, tables scroll inside
  their container. The settings tab bar scrolls inside its own box, which is
  existing behaviour.
- On a 375px phone: a sale of 7.5 m recorded from the product page (total
  1427 → 1419.5).
- Negative stock switched on through the settings screen. A sale of 40
  against 35 showed the warning ("available 35, requested 40, balance would
  be −5"), then "Record anyway" recorded it at −5.
- New product form: empty submit names 4 required fields. A duplicate SKU
  names the existing product in Arabic. Arabic-Indic digits are accepted.
  The initial stock of 12.5 appears as a manual addition.
- Ledger check: "All 7 balances match their movements". No edit or delete
  control exists on the ledger.

## [DECISION REQUIRED]

None open. The four questions raised at the start of the phase were answered
(see "Decisions applied").

## Known limitations / later

- Notification delivery for the events is Phase 15. Reports are Phase 12.
- `product_stock.average_cost` is not trigger-guarded; only its quantity is.
  Reconciliation detects and repairs a drifted average.
- The product list filters and sorts by derived totals in the application,
  after loading the company's catalogue. That suits V1's SME scale; a large
  catalogue would need an aggregate query.

## Verification results

| Check                     | Result                                                                |
| ------------------------- | --------------------------------------------------------------------- |
| `prettier --check .`      | clean                                                                 |
| `turbo run lint`          | 0 errors (the 4 existing `no-console` warnings in the db seed script) |
| `turbo run typecheck`     | clean                                                                 |
| `turbo run test --force`  | **1598 tests**, all passing                                           |
| `turbo run build --force` | 8 / 8                                                                 |

| Package        | Tests | Phase 14 additions                                                          |
| -------------- | ----- | --------------------------------------------------------------------------- |
| `packages/db`  | 312   | **+13** — `test/phase14-rls.test.ts`                                        |
| `apps/api`     | 917   | **+54** — `inventory-rules.test.ts` (12), `test/inventory.e2e.test.ts` (42) |
| `apps/web`     | 256   | **+17** — `lib/inventory.test.ts`                                           |
| other packages | 113   | unchanged                                                                   |
