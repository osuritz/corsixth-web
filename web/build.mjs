import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TESTS = process.argv.includes('--tests');
const OUT = TESTS ? 'dist-test' : 'dist';
mkdirSync(OUT, { recursive: true });

if (TESTS) {
  await build({ entryPoints: ['src/onboarding.test.ts', 'src/xmi2mid.test.ts', 'src/wav.test.ts', 'src/fs-setup.test.ts'],
    bundle: true, format: 'esm', outdir: OUT, platform: 'node', external: ['node:test', 'node:assert'] });
  process.exit(0);
}

await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife',
  outfile: join(OUT, 'main.js'), sourcemap: true, minify: false });
cpSync('src/index.html', join(OUT, 'index.html'));
cpSync('src/style.css', join(OUT, 'style.css'));

await build({ entryPoints: ['src/music-render.ts'], bundle: true, format: 'iife',
  outfile: join(OUT, 'music-render.js'), sourcemap: true, minify: false });

// Stage the GM soundfont (freely-licensed third-party asset, NOT TH data) into dist/ if
// it has been fetched. Not fatal when absent locally — CI/deploy runs `fetch-assets`.
try {
  const sf = '.assets/FluidR3.sf3';
  if (statSync(sf).isFile()) cpSync(sf, join(OUT, 'FluidR3.sf3'));
} catch { console.warn('note: FluidR3.sf3 not staged (run `npm run fetch-assets`) — music render will be unavailable'); }

// Copy engine artifacts. ARTIFACTS_DIR override lets CI point at a downloaded artifact dir.
const artRoot = process.env.ARTIFACTS_DIR ?? '../build-wasm';
const found = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/^corsix-th\.(js|wasm|data)$/.test(e)) found.push(p);
  }
})(artRoot);
if (found.length !== 3) { console.error(`FAIL: expected 3 corsix-th.* artifacts under ${artRoot}, found ${found.length}`); process.exit(1); }
for (const f of found) cpSync(f, join(OUT, f.split('/').pop()));
console.log(`built ${OUT}/ with artifacts:`, found.map((f) => f.split('/').pop()).join(', '));
