/**
 * The smallest byte sequences each DOCUMENT 20 §7 type is recognised by, and
 * the disguises it must refuse. Shared by the attachment e2e suite.
 */

const ascii = (text: string): number[] => [...Buffer.from(text, 'latin1')];
const of = (...values: number[]): Buffer => Buffer.from(values);

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SAMPLES = {
  pdf: { mime: PDF_MIME, name: 'report.pdf', bytes: of(...ascii('%PDF-1.7\n1 0 obj\n')) },
  png: {
    mime: 'image/png',
    name: 'chart.png',
    bytes: of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13),
  },
  jpeg: { mime: 'image/jpeg', name: 'photo.jpg', bytes: of(0xff, 0xd8, 0xff, 0xe0, 0, 16) },
  webp: { mime: 'image/webp', name: 'scan.webp', bytes: of(...ascii('RIFF$\0\0\0WEBPVP8 ')) },
  docx: {
    mime: DOCX_MIME,
    name: 'brief.docx',
    bytes: of(0x50, 0x4b, 0x03, 0x04, ...ascii('[Content_Types].xml word/document.xml')),
  },
  xlsx: {
    mime: XLSX_MIME,
    name: 'budget.xlsx',
    bytes: of(0x50, 0x4b, 0x03, 0x04, ...ascii('[Content_Types].xml xl/workbook.xml')),
  },
} as const;

/** Declared type, actual bytes — every one must be refused. */
export const DISGUISES: readonly (readonly [string, string, Buffer])[] = [
  ['a Windows executable labelled as a PDF', PDF_MIME, of(0x4d, 0x5a, 0x90, 0x00, 3, 0)],
  ['a PNG labelled as a PDF', PDF_MIME, SAMPLES.png.bytes],
  ['a PDF labelled as a PNG', 'image/png', SAMPLES.pdf.bytes],
  ['an HTML page', 'text/html', of(...ascii('<!doctype html><script>alert(1)</script>'))],
  ['an SVG with script', 'image/svg+xml', of(...ascii('<svg><script>alert(1)</script></svg>'))],
  [
    'a macro-enabled workbook labelled as XLSX',
    XLSX_MIME,
    of(0x50, 0x4b, 0x03, 0x04, ...ascii('[Content_Types].xml xl/workbook.xml xl/vbaProject.bin')),
  ],
  ['a plain ZIP labelled as DOCX', DOCX_MIME, of(0x50, 0x4b, 0x03, 0x04, ...ascii('payload.exe'))],
  ['a shell script', 'application/x-sh', of(...ascii('#!/bin/sh\nrm -rf /\n'))],
];
