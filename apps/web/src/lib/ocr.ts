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
