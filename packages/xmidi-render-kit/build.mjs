import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const TESTS = process.argv.includes('--tests');
const OUT = TESTS ? 'dist-test' : 'dist';
mkdirSync(OUT, { recursive: true });

if (TESTS) {
  await build({
    entryPoints: ['src/xmi2mid.test.ts', 'src/wav.test.ts', 'src/render.test.ts'],
    bundle: true,
    format: 'esm',
    outdir: OUT,
    platform: 'node',
    external: ['node:test', 'node:assert'],
  });
  process.exit(0);
}

// Single bundled ESM entry point for the library itself. spessasynth_core and
// wasm-media-encoders stay external (regular `dependencies`, not vendored) so consumers get
// their own copy via their package manager/bundler rather than a duplicated, unpatchable one.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/index.js',
  platform: 'neutral',
  sourcemap: true,
  minify: false,
  external: ['spessasynth_core', 'wasm-media-encoders'],
});

// Declarations via tsc (esbuild does not type-check or emit .d.ts).
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' });

console.log('built dist/ (index.js + index.d.ts + friends)');
