/**
 * DOCUMENT 21's action names on the wire.
 *
 * The database stores each action as DOCUMENT 21 spells it
 * (`attendance.checked_in`); Prisma names the same values `ATTENDANCE_CHECKED_IN`
 * and maps between them with `@map`. The API speaks DOCUMENT 21's spelling in
 * both directions — in the payload and in the `action` filter — so a client
 * never learns a second vocabulary.
 *
 * The mapping is read from the generated client's own schema description
 * rather than restated here, so an action added to `schema.prisma` is
 * filterable and renderable without anyone remembering this file.
 */

import { Prisma } from '@ufuq/db';
import type { AuditAction } from '@ufuq/db';

const AUDIT_ACTION_ENUM = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'AuditAction');
if (AUDIT_ACTION_ENUM === undefined) {
  throw new Error('The generated Prisma client describes no AuditAction enum.');
}

const TO_WIRE = new Map<AuditAction, string>(
  AUDIT_ACTION_ENUM.values.map((value) => [value.name as AuditAction, value.dbName ?? value.name]),
);
const FROM_WIRE = new Map<string, AuditAction>([...TO_WIRE].map(([key, wire]) => [wire, key]));

/** Every audited action, as DOCUMENT 21 names it. */
export const AUDIT_ACTION_VALUES: readonly string[] = [...FROM_WIRE.keys()];

export function actionToWire(action: AuditAction): string {
  return TO_WIRE.get(action) ?? action;
}

/** Validated by the DTO first, so an unknown name never reaches here. */
export function actionFromWire(value: string): AuditAction {
  const action = FROM_WIRE.get(value);
  if (action === undefined) {
    throw new Error(`Unknown audit action: ${value}`);
  }
  return action;
}
