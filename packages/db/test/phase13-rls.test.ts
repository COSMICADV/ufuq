/**
 * Phase 13 row-level security, reference integrity and ledger guarantees —
 * AD-03, DOCUMENT 06 §3.28–3.32, DOCUMENT 17 rules 1–6, DOCUMENT 26 §5
 * ("No role can update or delete a stock movement").
 *
 * Same approach as the earlier phase suites: the real migrations, PGlite,
 * the restricted `ufuq_app` role, and statements with no `WHERE`.
 *
 * What is new in kind: a ledger the database itself keeps honest. A movement
 * must chain from the cached balance; the cache must equal the latest
 * movement; movements can never change; and a warehouse holding stock cannot
 * be deactivated.
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
    await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
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
  },
): string {
  const own = IDS[companyId as keyof typeof IDS];
  seq += 1;
  const id = `00000000-0000-7000-8000-0000000f${String(seq).padStart(4, '0')}`;
  return `INSERT INTO stock_movements (id, company_id, product_id, warehouse_id, type, quantity,
            unit_cost, balance_after, transfer_group_id, created_by, created_at)
          VALUES ('${id}', '${companyId}', '${own.product}', '${o.warehouse}', '${o.type}', ${o.qty},
            ${o.cost ?? 'NULL'}, ${o.balance}, ${o.group === undefined ? 'NULL' : `'${o.group}'`},
            '${own.user}', now() + interval '${String(seq)} milliseconds');`;
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
     INSERT INTO products (id, company_id, name_ar, name_en, sku, unit)
       VALUES ('${own.product}', '${companyId}', 'قماش', 'Fabric', 'FAB-1', 'metre');
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

  describe('tenant isolation', () => {
    for (const table of ['warehouses', 'products', 'product_stock', 'stock_movements']) {
      it(`${table}: a bare SELECT sees only the caller company; no tenant sees nothing`, async () => {
        const rows = await asApp<{ company_id: string }>(
          COMPANY_A,
          `SELECT company_id FROM ${table}`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.company_id === COMPANY_A)).toBe(true);
        expect(await asApp('', `SELECT * FROM ${table}`)).toHaveLength(0);
      });
    }

    it('an UPDATE with no WHERE cannot reach another company’s warehouse', async () => {
      await asApp(COMPANY_A, `UPDATE warehouses SET address = 'x'`);
      const other = await asApp<{ address: string | null }>(
        COMPANY_B,
        'SELECT address FROM warehouses',
      );
      expect(other.every((row) => row.address === null)).toBe(true);
    });

    it('a movement or stock row cannot point at another company’s warehouse or product', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO stock_movements (id, company_id, product_id, warehouse_id, type, quantity,
             balance_after, created_by)
           VALUES ('00000000-0000-7000-8000-00000000aa01', '${COMPANY_A}', '${A.product}', '${B.main}',
             'manual_addition', 1, 1, '${A.user}')`,
        ),
      );
      expect(message).toMatch(/same company|not active/);
    });

    it('SKU is unique per company, not across companies', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `INSERT INTO products (id, company_id, name_ar, name_en, sku, unit)
             VALUES ('00000000-0000-7000-8000-00000000ab01', '${COMPANY_A}', 'x', 'x', 'FAB-1', 'piece')`,
          ),
        ),
      ).toMatch(/duplicate key|company_id_sku_key/);
    });
  });

  describe('movements are immutable (DOCUMENT 17 rule 2)', () => {
    it('the application role can neither UPDATE nor DELETE a movement', async () => {
      expect(
        await expectRejection(() => asApp(COMPANY_A, `UPDATE stock_movements SET quantity = 1`)),
      ).toMatch(/permission denied/i);
      expect(await expectRejection(() => asApp(COMPANY_A, `DELETE FROM stock_movements`))).toMatch(
        /permission denied/i,
      );
    });

    it('nor can the table owner: the trigger refuses UPDATE, DELETE and TRUNCATE for every role', async () => {
      for (const sql of [
        `UPDATE stock_movements SET reason = 'rewritten'`,
        `DELETE FROM stock_movements`,
        `TRUNCATE stock_movements`,
      ]) {
        expect(await expectRejection(() => asOwner(COMPANY_A, sql))).toMatch(/immutable/);
      }
      expect(await asApp(COMPANY_A, 'SELECT id FROM stock_movements')).toHaveLength(1);
    });

    it('no database function writes to stock_movements or product_stock', async () => {
      const rows = await db.query<{ proname: string }>(
        `SELECT proname FROM pg_proc
          WHERE prosrc ~* '(update|delete\\s+from|insert\\s+into)\\s+"?(stock_movements|product_stock)'`,
      );
      expect(rows.rows).toEqual([]);
    });
  });

  describe('the cache always equals the ledger (DOCUMENT 17 rules 1, 3, 6)', () => {
    it('a quantity written without a movement is refused, for the app and the owner', async () => {
      for (const run of [asApp, asOwner] as const) {
        expect(
          await expectRejection(() => run(COMPANY_A, `UPDATE product_stock SET quantity = 999`)),
        ).toMatch(/does not match the ledger/);
      }
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `INSERT INTO product_stock (id, company_id, product_id, warehouse_id, quantity)
             VALUES ('00000000-0000-7000-8000-00000000ac01', '${COMPANY_A}', '${A.product}', '${A.online}', 5)`,
          ),
        ),
      ).toMatch(/does not match the ledger/);
    });

    it('a movement must chain from the cached balance', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            movement(COMPANY_A, {
              warehouse: A.main,
              type: 'manual_removal',
              qty: '-0.500',
              balance: '999',
            }),
          ),
        ),
      ).toMatch(/does not follow the balance/);
    });

    it('a paired transfer, written as the ledger service writes it, is accepted exactly', async () => {
      const group = '00000000-0000-7000-8000-00000000ad01';
      await asAppExec(
        COMPANY_A,
        `${movement(COMPANY_A, { warehouse: A.main, type: 'transfer_out', qty: '-20.250', balance: '100.250', cost: '35.00', group })}
         ${movement(COMPANY_A, { warehouse: A.online, type: 'transfer_in', qty: '20.250', balance: '20.250', cost: '35.00', group })}
         UPDATE product_stock SET quantity = 100.250 WHERE warehouse_id = '${A.main}';
         INSERT INTO product_stock (id, company_id, product_id, warehouse_id, quantity, average_cost)
           VALUES ('00000000-0000-7000-8000-00000000ad02', '${COMPANY_A}', '${A.product}', '${A.online}', 20.250, 35.00);`,
      );
      const rows = await asApp<{ warehouse_id: string; quantity: string }>(
        COMPANY_A,
        'SELECT warehouse_id, quantity FROM product_stock ORDER BY quantity DESC',
      );
      expect(rows).toEqual([
        { warehouse_id: A.main, quantity: '100.250' },
        { warehouse_id: A.online, quantity: '20.250' },
      ]);
    });

    it('a transfer leg needs its group; out is negative, in positive and costed', async () => {
      for (const [o, pattern] of [
        [
          { warehouse: A.main, type: 'transfer_out', qty: '-1', balance: '119.500' },
          /transfer_group/,
        ],
        [
          { warehouse: A.main, type: 'transfer_out', qty: '1', balance: '121.500', group: A.stock },
          /stock_movements_transfer_sign|stock_movements_direction/,
        ],
        [
          { warehouse: A.online, type: 'transfer_in', qty: '1', balance: '1', group: A.stock },
          /stock_movements_transfer_in_cost|stock_movements_inbound_cost/,
        ],
      ] as const) {
        expect(await expectRejection(() => asApp(COMPANY_A, movement(COMPANY_A, o)))).toMatch(
          pattern,
        );
      }
    });

    it('stock never goes negative while the company setting is off (the default)', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            movement(COMPANY_A, {
              warehouse: A.main,
              type: 'manual_removal',
              qty: '-200',
              balance: '-79.500',
            }),
          ),
        ),
      ).toMatch(/would leave a negative balance/);
    });
  });

  describe('warehouses keep their history', () => {
    it('a warehouse holding stock cannot be deactivated or deleted, by anyone', async () => {
      for (const run of [asApp, asOwner] as const) {
        expect(
          await expectRejection(() =>
            run(COMPANY_A, `UPDATE warehouses SET is_active = false WHERE id = '${A.main}'`),
          ),
        ).toMatch(/still holds stock/);
      }
      expect(
        await expectRejection(() =>
          asOwner(COMPANY_A, `DELETE FROM warehouses WHERE id = '${A.main}'`),
        ),
      ).toMatch(/never hard-deleted|foreign key/);
      expect(await expectRejection(() => asApp(COMPANY_A, `DELETE FROM warehouses`))).toMatch(
        /permission denied/i,
      );
    });

    it('an empty warehouse can be deactivated, and then takes no movement', async () => {
      await asApp(COMPANY_A, `UPDATE warehouses SET is_active = false WHERE id = '${A.online}'`);
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            movement(COMPANY_A, {
              warehouse: A.online,
              type: 'manual_addition',
              qty: '1',
              balance: '1',
            }),
          ),
        ),
      ).toMatch(/not active/);
    });

    it('every warehouse type is accepted, and only those', async () => {
      for (const type of ['main', 'branch', 'store', 'production', 'online']) {
        await asApp(
          COMPANY_A,
          `INSERT INTO warehouses (id, company_id, name_ar, name_en, type)
           VALUES (gen_random_uuid(), '${COMPANY_A}', 'م', 'W', '${type}')`,
        );
      }
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `INSERT INTO warehouses (id, company_id, name_ar, name_en, type)
             VALUES (gen_random_uuid(), '${COMPANY_A}', 'م', 'W', 'marketplace')`,
          ),
        ),
      ).toMatch(/invalid input value for enum/);
    });
  });
});
