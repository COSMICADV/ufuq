/**
 * An in-memory {@link ObjectStorage} for the e2e suites — the attachment
 * counterpart of `FakeRedis` and the capturing mail transport. Every write is
 * kept, so a test can assert what reached storage (the key, the bytes, the
 * digest) and what did not.
 */

import { Readable } from 'node:stream';

import type { ObjectStorage, StoredObjectInput } from '../src/attachments/object-storage.js';

export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObjectInput>();

  put(input: StoredObjectInput): Promise<void> {
    this.objects.set(input.key, input);
    return Promise.resolve();
  }

  get(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return Promise.reject(new Error(`No object at ${key}`));
    }
    return Promise.resolve(Readable.from([object.body]));
  }
}
