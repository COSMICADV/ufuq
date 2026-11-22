/**
 * On-device text recognition for receipts: Tesseract (WebAssembly) running in
 * a Web Worker, with its engine and Arabic + English data served from this
 * origin (`/ocr`, copied at build time). The image never leaves the browser.
 * Loaded only when the person asks for a receipt to be read.
 */

import type { Worker as OcrWorker } from 'tesseract.js';

let worker: Promise<OcrWorker> | null = null;
let progress: ((fraction: number) => void) | undefined;

async function getWorker(): Promise<OcrWorker> {
  worker ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    return createWorker(['ara', 'eng'], 1, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr/core',
      langPath: '/ocr/lang',
      gzip: true,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') progress?.(m.progress);
      },
    });
  })();
  try {
    return await worker;
  } catch (error) {
    worker = null;
    throw error;
  }
}

/** The text of an image (a canvas from `preparePhoto`, or a Blob). */
export async function recognise(
  image: HTMLCanvasElement | Blob,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  progress = onProgress;
  try {
    const ocr = await getWorker();
    const result = await ocr.recognize(image);
    return result.data.text;
  } finally {
    progress = undefined;
  }
}

let digitWorker: Promise<OcrWorker> | null = null;

/** A digits-only worker (single text line) for odometers; English data is enough. */
async function getDigitWorker(): Promise<OcrWorker> {
  digitWorker ??= (async () => {
    const { createWorker, PSM } = await import('tesseract.js');
    const w = await createWorker('eng', 1, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr/core',
      langPath: '/ocr/lang',
      gzip: true,
      workerBlobURL: false,
    });
    await w.setParameters({
      tessedit_char_whitelist: '0123456789 ',
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    });
    return w;
  })();
  try {
    return await digitWorker;
  } catch (error) {
    digitWorker = null;
    throw error;
  }
}

/** Grayscale with stretched contrast, optionally inverted (light digits on a dark display). */
function prepared(source: HTMLCanvasElement, invert: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i] ?? 0) * 0.299 + (data[i + 1] ?? 0) * 0.587 + (data[i + 2] ?? 0) * 0.114;
    data[i] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < data.length; i += 4) {
    let y = (((data[i] ?? 0) - min) * 255) / range;
    if (invert) y = 255 - y;
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The digit text of an odometer photo, read twice (as is, and inverted) so
 * both dark-on-light and light-on-dark displays have a chance. On the device only.
 */
export async function recogniseDigits(canvas: HTMLCanvasElement): Promise<string[]> {
  const ocr = await getDigitWorker();
  const out: string[] = [];
  for (const invert of [false, true]) {
    const result = await ocr.recognize(prepared(canvas, invert));
    out.push(result.data.text);
  }
  return out;
}
