/**
 * Create the staging bucket if it does not exist yet. The staging object
 * store (MinIO on a free instance) starts empty after every restart; the API
 * expects the bucket to be there (AD-02).
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
