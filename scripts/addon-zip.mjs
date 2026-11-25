// Packs blender/addon/yotablender_import into an installable Blender extension zip
// (manifest at the zip root, like `blender --command extension build`).
// Used by `npm run addon` (writes blender/dist/) and by the Vite build (served next to the app).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

export const ADDON_DIR = fileURLToPath(new URL('../blender/addon/yotablender_import/', import.meta.url));

export function addonVersion() {
  const m = readFileSync(join(ADDON_DIR, 'blender_manifest.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('No version in blender_manifest.toml');
  return m[1];
}

export function buildAddonZip() {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '__pycache__' || name.endsWith('.pyc')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(ADDON_DIR, p).split(sep).join('/')] = [readFileSync(p), { mtime: new Date('2026-01-01T00:00:00Z') }];
    }
  };
  walk(ADDON_DIR);
  return zipSync(files, { level: 9 });
}
