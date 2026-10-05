/**
 * Private object storage — AD-02 (S3-compatible; MinIO locally).
 *
 * Services depend on this interface, not on an S3 SDK, for the same reason
 * mail does (`MailTransport`): the provider is one decision in one module, and
 * the e2e suites can run against an in-memory store with no network.
 *
 * Nothing here can produce a URL. There is no presigned or public link in the
 * interface at all, so no caller can hand one out by mistake: every byte
 * leaves through the authorization-checked `GET /attachments/{id}`
 * (DOCUMENT 08 §4.14, DOCUMENT 20 §7 "Serving").
 */

import type { Readable } from 'node:stream';

export interface StoredObjectInput {
  /** Generated, company-namespaced, non-guessable — never derived from a user-supplied name. */
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
  /** SHA-256, lowercase hex, kept with the object as metadata. */
  readonly checksum: string;
}

export interface ObjectStorage {
  put(input: StoredObjectInput): Promise<void>;
  /** The object's bytes as a stream. Rejects when the object does not exist. */
  get(key: string): Promise<Readable>;
}

/** DI token for the process-wide {@link ObjectStorage}. */
export const OBJECT_STORAGE = Symbol('ufuq.api.object-storage');

/** DI token for the upload limits read from `STORAGE_*` (DOCUMENT 20 §7 "configurable"). */
export const ATTACHMENT_LIMITS = Symbol('ufuq.api.attachment-limits');

export interface AttachmentLimits {
  readonly maxUploadBytes: number;
}
