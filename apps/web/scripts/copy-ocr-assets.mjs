/**
 * Receipt reading runs in the browser (Tesseract, WebAssembly) and is served
 * from this origin only: the worker, the engine and the Arabic and English
 * language data are copied from node_modules into public/ocr at build time,
 * so a receipt image never leaves the person's device and no third-party
 * script or CDN is involved. public/ocr is generated, not committed.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'ocr');
const require = createRequire(import.meta.url);
const tesseract = dirname(require.resolve('tesseract.js/package.json'));
const core = dirname(createRequire(join(tesseract, 'package.json')).resolve('tesseract.js-core/package.json'));
const eng = dirname(require.resolve('@tesseract.js-data/eng/package.json'));
const ara = dirname(require.resolve('@tesseract.js-data/ara/package.json'));

mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });
copyFileSync(join(tesseract, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
for (const file of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  try {
    copyFileSync(join(core, file), join(out, 'core', file));
  } catch {
    // relaxed-SIMD builds exist only in newer cores; the others are enough.
  }
}
copyFileSync(join(eng, '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz'));
copyFileSync(join(ara, '4.0.0_best_int', 'ara.traineddata.gz'), join(out, 'lang', 'ara.traineddata.gz'));
console.log('OCR assets copied to public/ocr');
