/**
 * {@link ObjectStorage} over the S3 API — AD-02. MinIO locally
 * (`docker-compose.yml`, bucket created private with `mc anonymous set none`),
 * any S3-compatible store elsewhere, configured only through `STORAGE_*`.
 *
 * Objects are written with no ACL argument at all, so they inherit the
 * bucket's private default; nothing here ever asks for a public object or a
 * presigned URL.
 */

import { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Env } from '@ufuq/config';

import type { ObjectStorage, StoredObjectInput } from './object-storage.js';

/** The slice of `S3Client` used here — narrow, so a test can stand in for it. */
export interface S3Sender {
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

export function createS3Client(storage: Env['storage']): S3Client {
  return new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: storage.forcePathStyle,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
}

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  async put(input: StoredObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.length,
        // S3's own integrity check on the way in, from the same digest the
        // database row records.
        ChecksumSHA256: Buffer.from(input.checksum, 'hex').toString('base64'),
        Metadata: { sha256: input.checksum },
      }),
    );
  }

  async get(key: string): Promise<Readable> {
    const output = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { Body?: unknown };
    if (output.Body instanceof Readable) {
      return output.Body;
    }
    throw new Error('Object storage returned no readable body');
  }
}
