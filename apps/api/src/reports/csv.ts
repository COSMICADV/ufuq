/**
 * CSV for report exports — DOCUMENT 18 "Export & print" (CSV is V1 MUST
 * HAVE), DOCUMENT 20 (export hygiene).
 *
 *   - **UTF-8 with a byte-order mark**, so spreadsheet software opens Arabic
 *     text as Arabic rather than mojibake.
 *   - **RFC 4180 quoting**: a cell holding a comma, a quote, a line break or
 *     surrounding spaces is quoted, and quotes inside it are doubled. Lines
 *     end in CRLF.
 *   - **Exact values**: decimals arrive as the strings the API computed
 *     (`"5087.25"`, `"-3.000"`) and are written as they are — never through
 *     a JavaScript number.
 *   - **Formula injection**: a *text* cell starting with `=`, `+`, `-`, `@`,
 *     a tab or a carriage return is prefixed with an apostrophe so a
 *     spreadsheet shows it rather than evaluates it. A plain number (a
 *     negative quantity) is a number, not a formula, and is left alone.
 *   - **Self-describing** (DOCUMENT 18 rule 7): the file opens with the
 *     report's title, scope, range, filters, generation time and provisional
 *     state, a blank line, then the table.
 *
 * Pure; unit-tested.
 */

import type { Cell } from './report-types.js';

export const CSV_BOM = '﻿';
const LINE_END = '\r\n';
const NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** One cell, escaped. `null` is an empty cell. */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = value;
  if (FORMULA_START.test(text) && !NUMBER.test(text)) {
    text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(',') + LINE_END;
}

/** A column: its translated header and how to read it from a row. */
export interface CsvColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => Cell;
}

/** The leading block: one `label,value` line per fact, then a blank line. */
export function csvPreamble(facts: readonly (readonly [string, string])[]): string {
  return facts.map(([label, value]) => csvLine([label, value])).join('') + LINE_END;
}

export function csvHeader<Row>(columns: readonly CsvColumn<Row>[]): string {
  return csvLine(columns.map((column) => column.header));
}

export function csvRows<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  return rows.map((row) => csvLine(columns.map((column) => column.value(row)))).join('');
}
