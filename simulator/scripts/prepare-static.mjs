import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = path => resolve(root, path);
mkdirSync(at('public'), { recursive: true });
copyFileSync(at('MODEL.md'), at('public/model.txt'));

const lock = JSON.parse(readFileSync(at('package-lock.json'), 'utf8'));
const notices = ['Multiserver simulator — dependency notices',
  'All scene geometry is original, drawn with PixiJS. No third-party game assets, fonts, or branding are included.',
  'PGSimCity inspired the scene-first interaction design; no source or visual assets were copied.\n'];
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev) continue;
  notices.push(`${path.replace(/^node_modules\//, '')} ${pkg.version} — ${pkg.license}\n`);
  const files = readdirSync(at(path)).filter(file => /^licen[sc]e|^copying/i.test(file)).map(file => resolve(at(path), file));
  if (path === 'node_modules/@pixi/colord') files.push(at('licenses/colord.txt'));
  if (!files.length) throw new Error(`Missing dependency license: ${path}`);
  for (const file of files) notices.push(readFileSync(file, 'utf8'));
  notices.push('\n------------------------------------------------------------\n');
}
writeFileSync(at('public/notices.txt'), notices.join('\n'));
