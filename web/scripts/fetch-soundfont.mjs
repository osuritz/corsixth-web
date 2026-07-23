// Fetch the GM soundfont (a freely-licensed third-party asset — NOT TH data) into
// web/.assets/ (dev, gitignored) and, with --dist, into web/dist/ for deploy. SHA256-
// pinned and fail-closed. Never committed to git; served from our own origin, lazy-
// loaded only during onboarding's music-render step.
//
// FluidR3 GM is MIT-licensed (Frank Wen, 2000-2002/2008); license text confirmed at
// https://github.com/Jacalz/fluid-soundfont/blob/master/original-files/COPYING (mirrored
// verbatim from the original Fluid release) — see docs/superpowers/reports/m3-synth-decision.md
// for the full evidence trail (M3 music spike, Task 2).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const URL_ = 'https://raw.githubusercontent.com/Jacalz/fluid-soundfont/master/SF3/FluidR3.sf3';
const SHA256 = '32039e039c2f708467a6f171fbfd9fecdcadfe40a2327837c391490c8de70021';
const NAME = 'FluidR3.sf3';
const ASSETS = resolve('.assets');
const cached = resolve(ASSETS, NAME);

async function ensure() {
  mkdirSync(ASSETS, { recursive: true });
  if (!existsSync(cached)) {
    const res = await fetch(URL_);
    if (!res.ok) { console.error(`FAIL: soundfont fetch ${res.status}`); process.exit(1); }
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== SHA256) { console.error(`FAIL: soundfont sha256 ${got} != ${SHA256}`); process.exit(1); }
    writeFileSync(cached, buf);
    console.log(`fetched ${NAME} (${buf.length} bytes, sha256 OK)`);
  } else {
    const got = createHash('sha256').update(readFileSync(cached)).digest('hex');
    if (got !== SHA256) { console.error(`FAIL: cached ${NAME} sha256 mismatch — delete web/.assets and refetch`); process.exit(1); }
    console.log(`cached ${NAME} present, sha256 OK`);
  }
  if (process.argv.includes('--dist')) {
    mkdirSync(resolve('dist'), { recursive: true });
    copyFileSync(cached, resolve('dist', NAME));
    console.log(`copied ${NAME} -> dist/`);
  }
}
await ensure();
