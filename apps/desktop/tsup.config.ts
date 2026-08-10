import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/main.ts'],
  external: ['electron'],
  format: ['esm'],
  outDir: 'dist/main',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
