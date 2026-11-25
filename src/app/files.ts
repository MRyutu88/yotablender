// Getting files on and off the phone: the share sheet (Drive, Gmail, Quick Share…) with a
// plain download as fallback, and a file picker for opening projects.

import { strToU8, zipSync } from 'fflate';
import type { Project } from '../core/scene/scene';
import { exportObj } from '../core/io/obj';
import { serializeProject } from '../core/io/projectJson';

export type ShareResult = 'shared' | 'downloaded' | 'cancelled';

export async function shareOrDownload(files: File[], title: string): Promise<ShareResult> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files })) {
    try {
      await nav.share({ files, title });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
      // Some targets reject certain MIME types; fall back to downloading.
    }
  }
  for (const f of files) download(f);
  return 'downloaded';
}

export function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export const safeFileName = (s: string) => s.replace(/[^\w\-. ]+/g, '_').trim().replace(/\s+/g, '_') || 'model';

export function projectFile(p: Project): File {
  return new File([JSON.stringify(serializeProject(p))], `${safeFileName(p.name)}.yblend.json`, { type: 'application/json' });
}

/** OBJ + MTL, plus one PNG per painted object (`textures` by object id). */
export function objFiles(p: Project, applyMirror: boolean, asZip: boolean, textures: Record<string, { name: string; png: Uint8Array }> = {}): File[] {
  const base = safeFileName(p.name);
  const textureFiles = Object.fromEntries(Object.entries(textures).map(([id, t]) => [id, t.name]));
  const { obj, mtl } = exportObj(p, { applyMirror, mtlName: `${base}.mtl`, textureFiles });
  const pngs = Object.values(textures);
  if (asZip) {
    const zip = zipSync({
      [`${base}.obj`]: strToU8(obj),
      [`${base}.mtl`]: strToU8(mtl),
      ...Object.fromEntries(pngs.map((t) => [t.name, [t.png, { level: 0 }] as [Uint8Array, { level: 0 }]])),
    });
    return [new File([zip as BlobPart], `${base}.zip`, { type: 'application/zip' })];
  }
  // text/plain shares more reliably than model/obj on Android.
  return [
    new File([obj], `${base}.obj`, { type: 'text/plain' }),
    new File([mtl], `${base}.mtl`, { type: 'text/plain' }),
    ...pngs.map((t) => new File([t.png as BlobPart], t.name, { type: 'image/png' })),
  ];
}
