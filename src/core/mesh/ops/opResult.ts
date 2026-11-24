import type { MeshData } from '../mesh';
import type { Selection } from '../selection';
import { validateMesh } from '../validate';

/** Thrown when an op can't be applied; the message is shown to the user as a toast. */
export class OpError extends Error {}

export interface OpResult {
  data: MeshData;
  selection: Selection;
  /** For extrude: the direction to move the new geometry along (object space), if any. */
  normal?: [number, number, number];
  /** For extrude: each new copy (output index) and the input vertex it was copied from. */
  dupPairs?: { src: number; dup: number }[];
}

/** Refuses results that would break the mesh. Ops never commit invalid topology. */
export function checkResult(data: MeshData, what: string): void {
  const r = validateMesh(data);
  if (!r.ok) {
    const nonManifold = r.errors.some((e) => /non-manifold|same direction|duplicates/.test(e));
    throw new OpError(
      nonManifold ? `${what} would create non-manifold geometry` : `${what} failed: ${r.errors[0]}`,
    );
  }
}
