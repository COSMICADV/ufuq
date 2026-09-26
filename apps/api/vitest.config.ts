import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS's own recipe for testing decorator-metadata-dependent code
  // (constructor injection, ValidationPipe's whitelist/forbidNonWhitelisted)
  // under vitest: esbuild (vitest's default transform) does not implement
  // TypeScript's `emitDecoratorMetadata`, so `design:paramtypes` and
  // `design:type` are simply absent at runtime without this. `tsc` (the
  // `build`/`typecheck` scripts) always emitted it correctly; only the test
  // runner's own transform needed swc.
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The e2e suite boots a real (WASM) Postgres engine per file.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
