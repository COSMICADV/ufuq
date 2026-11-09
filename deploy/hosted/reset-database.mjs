/**
 * ONE-TIME FULL RESET — deletes every company, user and record, and every
 * uploaded file, so the site starts from zero accounts.
 *
 * Runs only when RESET_DATABASE_TOKEN is set, and only once per token value:
 * the token is recorded in `ops.resets`, outside the `public` schema the reset
 * drops, so a forgotten variable can never wipe the data a second time.
 *
 * The `public` schema is dropped and recreated empty; `start.sh` then applies
 * every migration from scratch and seeds the reference data (roles and
 * permissions) — exactly a fresh install.
 */

import { createRequire } from 'node:module';

const token = process.env.RESET_DATABASE_TOKEN?.trim();
if (!token) process.exit(0);

const requireDb = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const requireApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = requireDb('pg');

const client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
await client.connect();
try {
  await client.query('CREATE SCHEMA IF NOT EXISTS ops');
  await client.query(
    'CREATE TABLE IF NOT EXISTS ops.resets (token text PRIMARY KEY, done_at timestamptz NOT NULL DEFAULT now())',
  );
  const seen = await client.query('SELECT done_at FROM ops.resets WHERE token = $1', [token]);
  if (seen.rowCount > 0) {
    console.log(`Database reset for this token already ran at ${seen.rows[0].done_at.toISOString()} — skipping.`);
    process.exit(0);
  }

  const before = await client
    .query(
      "SELECT (SELECT count(*) FROM public.companies)::int AS companies, (SELECT count(*) FROM public.users)::int AS users",
    )
    .catch(() => ({ rows: [{ companies: '?', users: '?' }] }));
  console.log(
    `RESETTING DATABASE: removing ${before.rows[0].companies} companies and ${before.rows[0].users} users…`,
  );

  await client.query('BEGIN');
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
  await client.query('INSERT INTO ops.resets (token) VALUES ($1)', [token]);
  await client.query('COMMIT');
  console.log('Database emptied. Migrations and reference data are applied next.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error('Database reset FAILED — nothing was changed:', error);
  process.exit(1);
} finally {
  await client.end();
}

// Uploaded files belonged to the deleted records; remove them too.
try {
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = requireApi('@aws-sdk/client-s3');
  const bucket = process.env.STORAGE_BUCKET;
  const s3 = new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT,
    region: process.env.STORAGE_REGION,
    forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
  let removed = 0;
  let next;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: next }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }));
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      removed += keys.length;
    }
    next = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (next);
  console.log(`Removed ${removed} uploaded files from storage.`);
} catch (error) {
  console.error('Could not empty the storage bucket (the database reset still succeeded):', error);
}
