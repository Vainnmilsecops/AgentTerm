import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false,
  entry: ['src/preload.ts'],
  external: ['electron'],
  format: ['cjs'],
  outDir: 'dist/main',
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
