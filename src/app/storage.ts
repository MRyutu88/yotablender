// IndexedDB persistence: every project autosaves here (works offline), plus a few settings.

import { openDB, type IDBPDatabase } from 'idb';
import type { Project } from '../core/scene/scene';
import { deserializeProject, serializeProject, type ProjectFileV2 } from '../core/io/projectJson';

interface StoredProject {
  id: string;
  name: string;
  modified: number;
  objects: number;
  data: ProjectFileV2;
}

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  dbp ??= openDB('yotablender', 1, {
    upgrade(d) {
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('kv');
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

export async function saveProject(p: Project): Promise<void> {
  const rec: StoredProject = { id: p.id, name: p.name, modified: p.modified, objects: p.objects.length, data: serializeProject(p) };
  const d = await db();
  await d.put('projects', rec);
  await d.put('kv', p.id, 'lastProject');
}

export async function loadProject(id: string): Promise<Project | null> {
  const rec = (await (await db()).get('projects', id)) as StoredProject | undefined;
  return rec ? deserializeProject(rec.data) : null;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = (await (await db()).getAll('projects')) as StoredProject[];
  return all.map(({ id, name, modified, objects }) => ({ id, name, modified, objects })).sort((a, b) => b.modified - a.modified);
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).delete('projects', id);
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
