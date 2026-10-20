/**
 * Create the storage bucket if it does not exist yet (AD-02). The API only
 * reads and writes objects; it expects its bucket to be there.
 */

import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { CreateBucketCommand, HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3');

const bucket = process.env.STORAGE_BUCKET;
const client = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION,
  forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`Storage bucket "${bucket}" is ready.`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Created storage bucket "${bucket}".`);
}
