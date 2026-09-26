# DOCUMENT 17 — WAREHOUSE & INVENTORY SPECIFICATION

## PURPOSE
Track what the company owns, where it is, what it is worth, and every change that has ever happened to it — with a history that cannot be rewritten.

## Critical architectural rule

**Do not build two inventory systems.** In-house physical inventory and online inventory are not separate products with separate tables. They are **locations** within one unified model.

```
warehouses.type ∈ { main, branch, store, production, online }
```

An online channel is a warehouse whose type is `online`. Everything else — products, stock, movements, valuation, reporting — is identical. A future request for "add a second branch" or "add a marketplace channel" is a data insert, not a new module.

## USERS
| User | Interaction |
|---|---|
| ADMIN | Full access in V1 |
| Future WAREHOUSE_MANAGER | Intended recipient of stock permissions |
| MANAGER / EMPLOYEE | No access in V1 |

## DATA
**warehouses:** name, type, address, is_active.
**products:** name, sku, category_id, unit, min_stock, cost_price, selling_price, supplier_id, image_path, description, status.
**product_categories**, **suppliers**.
**product_stock:** product_id, warehouse_id, quantity, average_cost — a **derived cache**.
**stock_movements:** product_id, warehouse_id, type, quantity (signed), unit_cost, balance_after, reference, transfer_group_id, reason, created_by — the **source of truth**, immutable.

**Movement types:** purchase · sale · transfer_in · transfer_out · adjustment · return · damage · manual_addition · manual_removal.

## SCREENS
Warehouse: `/admin/warehouse` dashboard · `/admin/warehouse/locations` · location detail · `/admin/warehouse/transfers`
Inventory: `/admin/inventory` product list · `/admin/inventory/new` · product detail · `/admin/inventory/:id/movements` · `/admin/inventory/movements` · `/admin/inventory/suppliers`

## WAREHOUSE DASHBOARD
KPIs: total products · total stock units · low-stock count · out-of-stock count · total inventory value.
Widgets: stock distribution by location · recent movements (last 20) · warehouse activity trend · low-stock table.

## BUSINESS RULES

1. **Quantity is never written directly.** Every change is a movement. There is no editable quantity field in the UI and no endpoint that sets a quantity.
2. **Stock movements are immutable.** No UPDATE, no DELETE, ever. A mistake is corrected by an opposing `adjustment` movement with a reason.
3. **`product_stock` is a cache** maintained by the movement service inside the same transaction as the movement. It must be fully rebuildable from `stock_movements`, and a reconciliation job proves this.
4. **Transfers produce two paired movements** — `transfer_out` at the source and `transfer_in` at the destination — sharing a `transfer_group_id`, inside one transaction. A half-completed transfer must be impossible.
5. **Outbound movements exceeding available stock are blocked**, unless the company explicitly enables negative stock, in which case a warning is shown and recorded.
6. **`balance_after` is stored on each movement** so history is readable without replaying the whole ledger.
7. **Low stock** is `quantity ≤ min_stock` and triggers a notification once per crossing, not on every subsequent movement.
8. **Out of stock** is `quantity = 0` and triggers a separate notification.
9. **`adjustment` and `damage` movements require a reason.**
10. **SKU is unique per company.**
11. **Valuation uses weighted average cost** in V1 (assumption A-05, OD-13). `average_cost` recalculates on inbound movements:
    ```
    new_avg = ((old_qty × old_avg) + (in_qty × in_cost)) ÷ (old_qty + in_qty)
    ```
12. **Products are soft-deleted only.** Movement history must survive.
13. **Inventory value** = Σ over locations of `quantity × average_cost`.
14. **All movements are audited** in addition to being immutable records themselves.

## PERMISSIONS
`warehouse.view` · `warehouse.manage` · `product.view` · `product.create` · `product.update` · `stock.view` · `stock.movement_create` · `stock.transfer`. All ADMIN-only in V1.

## API REQUIREMENTS
The warehouse and inventory sets per DOCUMENT 08 §4.11. Movement creation accepts `Idempotency-Key`.

**There is no `PATCH /products/{id}/quantity`.** Any future proposal to add one must be rejected — it would break the audit chain that the entire module exists to protect.

## DATABASE REQUIREMENTS
Unique `(company_id, sku)` and `(product_id, warehouse_id)`. Indexes on `(company_id, product_id, created_at)`, `(warehouse_id, created_at)`, `transfer_group_id`. Quantities `DECIMAL(15,3)` to support fractional units such as metres and kilograms. Money `DECIMAL(15,2)`. Foreign keys `RESTRICT`. Movements never soft-deleted, never hard-deleted.

## VALIDATION
- SKU required, unique per company, 1–50 characters.
- Name required.
- `min_stock ≥ 0`, `cost_price ≥ 0`, `selling_price ≥ 0`.
- Movement quantity ≠ 0.
- Outbound quantity ≤ available at that location, unless negative stock is enabled.
- Transfer source ≠ destination, and both must be active.
- Reason required for `adjustment` and `damage`.
- Unit cost required for `purchase` and `transfer_in`.
- Referenced warehouse, supplier, and category must belong to the same company.

## ERROR STATES
| Situation | Handling |
|---|---|
| Insufficient stock | "الكمية المتاحة ١٢٠ والطلب ٢٠٠" with the available figure shown |
| Duplicate SKU | Field-level error naming the existing product |
| Transfer to the same location | Blocked at validation |
| Movement in a closed period | If inventory period-closing is enabled (future), blocked |
| Product deactivated with stock remaining | Warned — the product is hidden from selection but its stock and history remain |
| Cache and ledger disagree | Reconciliation job flags it, rebuilds from movements, and raises an alert. Never silently corrects without a record |

## EDGE CASES
| Case | Handling |
|---|---|
| Negative stock | Blocked by default; permitted only when explicitly enabled, always warned and recorded |
| Concurrent movements on the same product | Row-level lock on `product_stock` inside the transaction; movements serialise correctly |
| Transfer fails midway | Transaction rolls back; neither movement exists |
| Correcting a wrong quantity | An opposing `adjustment` movement with a reason. The original is never edited |
| Product deleted with movement history | Soft delete only; history is preserved and reportable |
| Warehouse deactivated with stock | Blocked until the stock is transferred out |
| Cost price changes | Historical movements keep their original `unit_cost`; only future inbound movements use the new cost |
| Fractional units | `DECIMAL(15,3)` supports metres, kilograms, litres |
| Bulk import | Not in V1; when added it must create movements, not direct quantity writes |
| Same product in several warehouses | Fully supported — quantity is per `(product, warehouse)` and the product list shows the total across locations |

## MOBILE BEHAVIOUR
Warehouse management is desktop-first — it is an office task with dense tables.
On tablet, tables scroll horizontally with a frozen first column.
On mobile, product lists become cards and the movement form is usable but not optimised. Barcode scanning and a mobile-first stock-taking flow are explicitly future work.

## FUTURE EXTENSIONS
Barcode and QR scanning, purchase orders and goods receipt, sales orders, batch and lot tracking with expiry, serial numbers, FIFO/LIFO valuation, stock-take and cycle-count sessions with variance reports, reorder-point automation, multi-unit conversion (box ↔ piece), supplier price lists, landed-cost allocation, and e-commerce channel synchronisation. None in V1.
