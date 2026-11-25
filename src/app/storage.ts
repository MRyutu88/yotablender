// IndexedDB persistence: every project autosaves here (works offline), plus a few settings.

import { openDB, type IDBPDatabase } from 'idb';
import type { Project } from '../core/scene/scene';
import { deserializeProject, serializeProject, type ProjectFileV3 } from '../core/io/projectJson';

interface StoredProject {
  id: string;
  name: string;
  modified: number;
  objects: number;
  /** The project file without image bytes; those live in the 'images' store. */
  data: ProjectFileV3;
}

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  dbp ??= openDB('yotablender', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('kv');
      }
      // Texture PNGs, keyed "<project id>/<image name>", written only when they change.
      if (oldVersion < 2) d.createObjectStore('images');
    },
  });
  return dbp;
}

export interface ProjectMeta {
  id: string;
  name: string;
  modified: number;
  objects: number;
}

/** PNG buffers already written, per storage key (so unchanged textures aren't rewritten). */
const savedImages = new Map<string, Uint8Array>();
const imageKey = (projectId: string, name: string) => `${projectId}/${name}`;

export async function saveProject(p: Project): Promise<void> {
  const rec: StoredProject = {
    id: p.id,
    name: p.name,
    modified: p.modified,
    objects: p.objects.length,
    data: serializeProject(p, { embedImages: false }),
  };
  const d = await db();
  const tx = d.transaction(['projects', 'kv', 'images'], 'readwrite');
  const images = tx.objectStore('images');
  const keep = new Set<string>();
  for (const im of p.images) {
    const k = imageKey(p.id, im.name);
    keep.add(k);
    if (savedImages.get(k) !== im.png) {
      void images.put(im.png, k);
      savedImages.set(k, im.png);
    }
  }
  // Images of this project that are gone (texture removed / object deleted).
  for (const k of (await images.getAllKeys(IDBKeyRange.bound(`${p.id}/`, `${p.id}/\uffff`))) as string[]) {
    if (!keep.has(k)) {
      void images.delete(k);
      savedImages.delete(k);
    }
  }
  void tx.objectStore('projects').put(rec);
  void tx.objectStore('kv').put(p.id, 'lastProject');
  await tx.done;
}

export async function loadProject(id: string): Promise<Project | null> {
  const d = await db();
  const rec = (await d.get('projects', id)) as StoredProject | undefined;
  if (!rec) return null;
  const bytes = new Map<string, Uint8Array>();
  for (const im of rec.data.images ?? []) {
    const k = imageKey(id, im.name);
    const png = (await d.get('images', k)) as Uint8Array | undefined;
    if (png) {
      bytes.set(im.name, png);
      savedImages.set(k, png);
    }
  }
  const p = deserializeProject(rec.data, (n) => bytes.get(n));
  return p;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = (await (await db()).getAll('projects')) as StoredProject[];
  return all.map(({ id, name, modified, objects }) => ({ id, name, modified, objects })).sort((a, b) => b.modified - a.modified);
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db();
  await d.delete('projects', id);
  await d.delete('images', IDBKeyRange.bound(`${id}/`, `${id}/\uffff`));
}

export async function lastProjectId(): Promise<string | null> {
  return ((await (await db()).get('kv', 'lastProject')) as string | undefined) ?? null;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await (await db()).get('kv', `setting:${key}`);
    return v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await (await db()).put('kv', value, `setting:${key}`);
}

/** Asks the browser not to evict our storage (Android may otherwise clear it under pressure). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Debounced autosave that also flushes when the app goes to the background. */
export class Autosaver {
  private timer = 0;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private persistAsked = false;

  constructor(
    private get: () => Project,
    private onState: (s: 'saved' | 'saving' | 'dirty') => void,
    private onError: (e: unknown) => void,
    private delay = 1000,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
    window.addEventListener('pagehide', () => void this.flush());
  }

  schedule(): void {
    this.dirty = true;
    this.onState('dirty');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), this.delay);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    if (this.saving) await this.saving;
    this.dirty = false;
    this.onState('saving');
    const p = this.get();
    p.modified = Date.now();
    this.saving = saveProject(p)
      .then(() => {
        this.onState(this.dirty ? 'dirty' : 'saved');
        if (!this.persistAsked) {
          this.persistAsked = true;
          void requestPersistence();
        }
      })
      .catch((e) => {
        this.dirty = true;
        this.onState('dirty');
        this.onError(e);
      })
      .finally(() => (this.saving = null));
    await this.saving;
  }
}
