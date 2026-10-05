/**
 * AD-02 — what the S3 adapter asks the store for. A stub stands in for the
 * client, so the exact command is asserted with no network.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { S3ObjectStorage } from './s3-object-storage.js';
import type { S3Sender } from './s3-object-storage.js';

class StubClient implements S3Sender {
  readonly sent: (PutObjectCommand | GetObjectCommand)[] = [];
  constructor(private readonly reply: unknown = {}) {}
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown> {
    this.sent.push(command);
    return Promise.resolve(this.reply);
  }
}

const body = Buffer.from('%PDF-1.7\n');
const checksum = createHash('sha256').update(body).digest('hex');

describe('S3ObjectStorage', () => {
  it('puts the object privately, with the content type and an integrity checksum', async () => {
    const client = new StubClient();
    await new S3ObjectStorage(client, 'ufuq-local').put({
      key: 'company/abc',
      body,
      contentType: 'application/pdf',
      checksum,
    });
    const [command] = client.sent;
    expect(command).toBeInstanceOf(PutObjectCommand);
    const input = (command as PutObjectCommand).input;
    expect(input).toMatchObject({
      Bucket: 'ufuq-local',
      Key: 'company/abc',
      ContentType: 'application/pdf',
      ContentLength: body.length,
      ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
      Metadata: { sha256: checksum },
    });
    // No ACL at all: the object inherits the bucket's private default.
    expect(input).not.toHaveProperty('ACL');
  });

  it('gets the object as a stream', async () => {
    const stream = Readable.from([body]);
    const client = new StubClient({ Body: stream });
    const result = await new S3ObjectStorage(client, 'ufuq-local').get('company/abc');
    expect(result).toBe(stream);
    expect((client.sent[0] as GetObjectCommand).input).toEqual({
      Bucket: 'ufuq-local',
      Key: 'company/abc',
    });
  });

  it('refuses a response with no readable body', async () => {
    await expect(new S3ObjectStorage(new StubClient({}), 'b').get('k')).rejects.toThrow(
      /no readable body/,
    );
  });
});
