/**
 * Phase 14 row-level security, reference integrity and ledger guarantees —
 * AD-03, DOCUMENT 06 §3.29–3.33, DOCUMENT 17 rules 2, 5, 9, 12, DOCUMENT 26 §5.
 *
 * The real migrations on PGlite, as the restricted `ufuq_app` role. New in
 * Phase 14: categories and suppliers (tenant-isolated, same-company
 * references, never hard-deleted), the full movement semantics enforced by
 * the database (direction, reason, inbound cost), the setting-aware
 * negative-stock guard, the ledger `sequence`, and the guard a lost update
 * would need to defeat: a movement computed from a stale balance.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const MIGRATION_NAMES = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function migrationSql(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`${name}/migration.sql`, `file://${MIGRATIONS_DIRECTORY}`)),
    'utf8',
  );
}

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

function ids(prefix: string) {
  return {
    user: `00000000-0000-7000-8000-${prefix}a1`,
    main: `00000000-0000-7000-8000-${prefix}b1`,
    online: `00000000-0000-7000-8000-${prefix}b2`,
    product: `00000000-0000-7000-8000-${prefix}c1`,
    category: `00000000-0000-7000-8000-${prefix}c2`,
    supplier: `00000000-0000-7000-8000-${prefix}c3`,
    stock: `00000000-0000-7000-8000-${prefix}d1`,
    movement: `00000000-0000-7000-8000-${prefix}e1`,
  } as const;
}

const IDS = { [COMPANY_A]: ids('0000000001'), [COMPANY_B]: ids('0000000002') } as const;
const A = IDS[COMPANY_A];
const B = IDS[COMPANY_B];

let db: PGlite;

async function asOwner(companyId: string, sql: string): Promise<void> {
  await db.exec(`SELECT set_config('app.company_id', '${companyId}', false);\n${sql}`);
}

async function asApp<T>(companyId: string, sql: string): Promise<T[]> {
  await db.exec(`SET ROLE ufuq_app; SELECT set_config('app.company_id', '${companyId}', false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

/** Several statements, as the application role, in one transaction. */
async function asAppExec(companyId: string, sql: string): Promise<void> {
  await db.exec(`SET ROLE ufuq_app; SELECT set_config('app.company_id', '${companyId}', false);`);
  try {
    // Statement by statement, so the first failure is the one reported.
    await db.exec('BEGIN;');
    await db.exec(sql);
    await db.exec('COMMIT;');
  } catch (error) {
    await db.exec('ROLLBACK;');
    throw error;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function expectRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the database to reject the statement');
}

let seq = 0;
/** A movement and its cache update, in the order the ledger service writes them. */
function movement(
  companyId: string,
  o: {
    warehouse: string;
    type: string;
    qty: string;
    balance: string;
    cost?: string;
    group?: string;
    reason?: string;
  },
): string {
  const own = IDS[companyId as keyof typeof IDS];
  seq += 1;
  const id = `00000000-0000-7000-8000-0000000f${String(seq).padStart(4, '0')}`;
  return `INSERT INTO stock_movements (id, company_id, product_id, warehouse_id, type, quantity,
            unit_cost, balance_after, transfer_group_id, reason, created_by, created_at)
          VALUES ('${id}', '${companyId}', '${own.product}', '${o.warehouse}', '${o.type}', ${o.qty},
            ${o.cost ?? 'NULL'}, ${o.balance}, ${o.group === undefined ? 'NULL' : `'${o.group}'`},
            ${o.reason === undefined ? 'NULL' : `'${o.reason}'`},
            '${own.user}', now() + interval '${String(seq)} milliseconds');`;
}

/** The cache update that must follow a movement (the ledger service's second write). */
function cache(companyId: string, warehouse: string, qty: string): string {
  const own = IDS[companyId as keyof typeof IDS];
  return `UPDATE product_stock SET quantity = ${qty} WHERE product_id = '${own.product}' AND warehouse_id = '${warehouse}';`;
}

async function seedCompany(companyId: string, slug: string): Promise<void> {
  const own = IDS[companyId as keyof typeof IDS];
  await asOwner(
    companyId,
    `INSERT INTO companies (id, name, slug, timezone, updated_at)
       VALUES ('${companyId}', '${slug}', '${slug}', 'Africa/Cairo', now());
     INSERT INTO users (id, company_id, email, role_id, updated_at)
       VALUES ('${own.user}', '${companyId}', 'admin@${slug}.test', '${ROLE}', now());
     INSERT INTO warehouses (id, company_id, name_ar, name_en, type)
       VALUES ('${own.main}', '${companyId}', 'الرئيسي', 'Main', 'main'),
              ('${own.online}', '${companyId}', 'المتجر', 'Online store', 'online');
     INSERT INTO product_categories (id, company_id, name_ar, name_en)
       VALUES ('${own.category}', '${companyId}', 'أقمشة', 'Fabrics');
     INSERT INTO suppliers (id, company_id, name) VALUES ('${own.supplier}', '${companyId}', 'Delta');
     INSERT INTO products (id, company_id, name_ar, name_en, sku, unit, category_id, supplier_id, min_stock, cost_price)
       VALUES ('${own.product}', '${companyId}', 'قماش', 'Fabric', 'FAB-1', 'metre', '${own.category}', '${own.supplier}', 10, 35.00);
     ${movement(companyId, { warehouse: own.main, type: 'manual_addition', qty: '120.500', balance: '120.500', cost: '35.00' })}
     INSERT INTO product_stock (id, company_id, product_id, warehouse_id, quantity, average_cost)
       VALUES ('${own.stock}', '${companyId}', '${own.product}', '${own.main}', 120.500, 35.00);`,
  );
}

describe('with every migration applied', () => {
  beforeEach(async () => {
    db = new PGlite();
    for (const name of MIGRATION_NAMES) await db.exec(migrationSql(name));
    await db.exec(
      `INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
       VALUES ('${ROLE}', NULL, 'admin', 'Admin', 'مدير', true, now());`,
    );
    await seedCompany(COMPANY_A, 'company-a');
    await seedCompany(COMPANY_B, 'company-b');
  });

  afterEach(async () => {
    await db.close();
  });

  describe('tenant isolation (AD-03)', () => {
    for (const table of ['product_categories', 'suppliers']) {
      it(`${table}: a company sees only its own rows, and cannot write another's`, async () => {
        const rows = await asApp<{ company_id: string }>(
          COMPANY_A,
          `SELECT company_id FROM ${table}`,
        );
        expect(rows.map((r) => r.company_id)).toEqual([COMPANY_A]);
        expect(
          await asApp(
            COMPANY_A,
            `UPDATE ${table} SET updated_at = now() WHERE company_id = '${COMPANY_B}' RETURNING id`,
          ),
        ).toEqual([]);
        const column =
          table === 'suppliers'
            ? '(id, company_id, name) VALUES'
            : '(id, company_id, name_ar, name_en) VALUES';
        const values =
          table === 'suppliers'
            ? `('00000000-0000-7000-8000-0000000099f1', '${COMPANY_B}', 'x')`
            : `('00000000-0000-7000-8000-0000000099f1', '${COMPANY_B}', 'x', 'x')`;
        expect(
          await expectRejection(() => asApp(COMPANY_A, `INSERT INTO ${table} ${column} ${values}`)),
        ).toMatch(/row-level security/);
      });
    }

    it('a product cannot reference another company’s category or supplier, nor a category another’s parent', async () => {
      for (const sql of [
        `UPDATE products SET category_id = '${B.category}'`,
        `UPDATE products SET supplier_id = '${B.supplier}'`,
        `INSERT INTO product_categories (id, company_id, name_ar, name_en, parent_id)
           VALUES ('00000000-0000-7000-8000-0000000099f2', '${COMPANY_A}', 'x', 'x', '${B.category}')`,
      ]) {
        expect(await expectRejection(() => asOwner(COMPANY_A, sql))).toMatch(/same company/);
      }
    });

    it('a category cannot be its own parent', async () => {
      expect(
        await expectRejection(() =>
          asOwner(COMPANY_A, `UPDATE product_categories SET parent_id = id`),
        ),
      ).toMatch(/not_own_parent/);
    });
  });

  describe('soft deletion only (rule 12)', () => {
    it('products, categories and suppliers are never hard-deleted, by any role', async () => {
      for (const table of ['products', 'product_categories', 'suppliers']) {
        expect(
          await expectRejection(() => asApp(COMPANY_A, `DELETE FROM ${table}`)),
          table,
        ).toMatch(/permission denied/);
        expect(
          await expectRejection(() => asOwner(COMPANY_A, `DELETE FROM ${table}`)),
          table,
        ).toMatch(/never hard-deleted/);
      }
    });

    it('prices and minimum stock are never negative', async () => {
      for (const column of ['min_stock', 'cost_price', 'selling_price']) {
        expect(
          await expectRejection(() => asOwner(COMPANY_A, `UPDATE products SET ${column} = -1`)),
        ).toMatch(new RegExp(`products_${column}_non_negative`));
      }
    });
  });

  describe('movement semantics enforced by the database', () => {
    it('direction by type, a reason on adjustment and damage, a cost on every inbound movement', async () => {
      for (const [o, pattern] of [
        [
          { warehouse: A.main, type: 'sale', qty: '5', balance: '125.500' },
          /stock_movements_direction/,
        ],
        [
          { warehouse: A.main, type: 'purchase', qty: '-5', balance: '115.500', cost: '1.00' },
          /stock_movements_direction/,
        ],
        [
          { warehouse: A.main, type: 'damage', qty: '-1', balance: '119.500' },
          /stock_movements_reason_required/,
        ],
        [
          { warehouse: A.main, type: 'adjustment', qty: '-1', balance: '119.500', reason: ' ' },
          /stock_movements_reason_required/,
        ],
        [
          { warehouse: A.main, type: 'return', qty: '1', balance: '121.500' },
          /stock_movements_inbound_cost/,
        ],
        [
          { warehouse: A.main, type: 'adjustment', qty: '1', balance: '121.500', reason: 'x' },
          /stock_movements_inbound_cost/,
        ],
      ] as const) {
        expect(
          await expectRejection(() => asApp(COMPANY_A, movement(COMPANY_A, o))),
          JSON.stringify(o),
        ).toMatch(pattern);
      }
    });

    it('a discontinued product takes no movement', async () => {
      await asOwner(COMPANY_A, `UPDATE products SET status = 'discontinued'`);
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            movement(COMPANY_A, {
              warehouse: A.main,
              type: 'manual_removal',
              qty: '-1',
              balance: '119.500',
            }),
          ),
        ),
      ).toMatch(/is not active/);
    });

    it('a movement computed from a stale balance is refused — the write a lost update needs', async () => {
      // Two writers both read 120.500; the first commits a sale of 20.
      await asAppExec(
        COMPANY_A,
        `${movement(COMPANY_A, { warehouse: A.main, type: 'sale', qty: '-20', balance: '100.500', cost: '35.00' })}
         ${cache(COMPANY_A, A.main, '100.500')}`,
      );
      // The second, still believing 120.500, would record 90.500 and overwrite the cache.
      expect(
        await expectRejection(() =>
          asAppExec(
            COMPANY_A,
            `${movement(COMPANY_A, { warehouse: A.main, type: 'sale', qty: '-30', balance: '90.500', cost: '35.00' })}
             ${cache(COMPANY_A, A.main, '90.500')}`,
          ),
        ),
      ).toMatch(/does not follow the balance/);
      // Nor can it skip the movement and just write its cache value.
      expect(
        await expectRejection(() => asApp(COMPANY_A, cache(COMPANY_A, A.main, '90.500'))),
      ).toMatch(/does not match the ledger/);
    });

    it('every movement gets the next ledger sequence; nobody can set it', async () => {
      await asAppExec(
        COMPANY_A,
        `${movement(COMPANY_A, { warehouse: A.main, type: 'sale', qty: '-1', balance: '119.500', cost: '35.00' })}
         ${cache(COMPANY_A, A.main, '119.500')}`,
      );
      const rows = await asApp<{ sequence: string }>(
        COMPANY_A,
        `SELECT sequence::text FROM stock_movements ORDER BY sequence`,
      );
      const values = rows.map((r) => BigInt(r.sequence));
      expect(values).toHaveLength(2);
      expect((values[1] as bigint) > (values[0] as bigint)).toBe(true);
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `INSERT INTO stock_movements (id, company_id, product_id, warehouse_id, type, quantity, unit_cost, balance_after, created_by, sequence)
             VALUES ('00000000-0000-7000-8000-0000000099f3', '${COMPANY_A}', '${A.product}', '${A.main}', 'sale', -1, 35, 118.5, '${A.user}', 1)`,
          ),
        ),
      ).toMatch(/GENERATED ALWAYS|cannot insert/i);
    });
  });

  describe('negative stock (rule 5): only when the company enables it, never by a transfer', () => {
    const below = (type: string) =>
      `${movement(COMPANY_A, {
        warehouse: A.main,
        type,
        qty: '-130',
        balance: '-9.500',
        cost: '35.00',
        ...(type === 'transfer_out' ? { group: A.stock } : {}),
      })}
       ${cache(COMPANY_A, A.main, '-9.500')}`;

    it('off (the default): refused', async () => {
      expect(await expectRejection(() => asAppExec(COMPANY_A, below('sale')))).toMatch(
        /would leave a negative balance/,
      );
    });

    it('on: an outbound movement may go below zero; a transfer still may not; company B is unaffected', async () => {
      await asOwner(
        COMPANY_A,
        `UPDATE companies SET allow_negative_stock = true WHERE id = '${COMPANY_A}'`,
      );
      await asAppExec(COMPANY_A, below('sale'));
      const [row] = await asApp<{ quantity: string }>(
        COMPANY_A,
        `SELECT quantity::text FROM product_stock`,
      );
      expect(row?.quantity).toBe('-9.500');
      await asOwner(
        COMPANY_A,
        `UPDATE companies SET allow_negative_stock = false WHERE id = '${COMPANY_A}'`,
      );
      await asOwner(
        COMPANY_A,
        `UPDATE companies SET allow_negative_stock = true WHERE id = '${COMPANY_A}'`,
      );
      expect(
        await expectRejection(() =>
          asAppExec(
            COMPANY_A,
            `${movement(COMPANY_A, { warehouse: A.main, type: 'transfer_out', qty: '-1', balance: '-10.500', cost: '35.00', group: A.stock })}
             ${cache(COMPANY_A, A.main, '-10.500')}`,
          ),
        ),
      ).toMatch(/would leave a negative balance/);
      const sqlB = `${movement(COMPANY_B, { warehouse: B.main, type: 'sale', qty: '-130', balance: '-9.500', cost: '35.00' })}
        ${cache(COMPANY_B, B.main, '-9.500')}`;
      expect(await expectRejection(() => asAppExec(COMPANY_B, sqlB))).toMatch(
        /would leave a negative balance/,
      );
    });
  });

  describe('attachments', () => {
    it('accept the product as a related type', async () => {
      await asApp(
        COMPANY_A,
        `INSERT INTO attachments (id, company_id, uploaded_by, original_name, stored_path, mime_type, size_bytes, checksum, related_type, related_id)
         VALUES ('00000000-0000-7000-8000-0000000099f4', '${COMPANY_A}', '${A.user}', 'a.png', '${COMPANY_A}/a.png', 'image/png', 12,
                 '${'0'.repeat(64)}', 'product', '${A.product}')`,
      );
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `INSERT INTO attachments (id, company_id, uploaded_by, original_name, stored_path, mime_type, size_bytes, checksum, related_type, related_id)
             VALUES ('00000000-0000-7000-8000-0000000099f5', '${COMPANY_A}', '${A.user}', 'a.png', '${COMPANY_A}/b.png', 'image/png', 12,
                     '${'0'.repeat(64)}', 'supplier', '${A.product}')`,
          ),
        ),
      ).toMatch(/attachments_related_type_known/);
    });
  });
});
