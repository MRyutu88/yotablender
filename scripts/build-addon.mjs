// npm run addon → blender/dist/yotablender_import-<version>.zip
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addonVersion, buildAddonZip } from './addon-zip.mjs';

const out = fileURLToPath(new URL(`../blender/dist/yotablender_import-${addonVersion()}.zip`, import.meta.url));
mkdirSync(fileURLToPath(new URL('../blender/dist/', import.meta.url)), { recursive: true });
writeFileSync(out, buildAddonZip());
console.log(out);
