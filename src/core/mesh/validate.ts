// Topology validity checks. Run after every op in tests (and in dev builds), and used by ops
// to refuse results that would break the mesh.

import { buildTopology } from './topology';
import { edgeKey, type MeshData } from './mesh';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateMesh(mesh: MeshData): ValidationResult {
  const errors: string[] = [];
  const nV = mesh.positions.length / 3;

  if (!Number.isInteger(nV)) errors.push('positions length is not a multiple of 3');
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i])) {
      errors.push(`vertex ${Math.floor(i / 3)} has a non-finite coordinate`);
      break;
    }
  }

  // Duplicate faces (same vertex set) are degenerate even when their winding is opposite.
  const faceSets = new Set<string>();
  mesh.faces.forEach((f, i) => {
    const key = f.slice().sort((a, b) => a - b).join(',');
    if (faceSets.has(key)) errors.push(`face ${i} duplicates another face`);
    faceSets.add(key);
  });

  const t = buildTopology(mesh);
  errors.push(...t.errors);

  for (let h = 0; h < t.nHe; h++) {
    const n = t.heNext[h], p = t.hePrev[h], tw = t.heTwin[h];
    if (n < 0 || n >= t.nHe) errors.push(`half-edge ${h} has no next (dangling)`);
    else if (t.hePrev[n] !== h) errors.push(`half-edge ${h}: prev(next) mismatch`);
    if (p < 0 || p >= t.nHe) errors.push(`half-edge ${h} has no prev (dangling)`);
    if (tw < 0 || tw >= t.nHe || tw === h) errors.push(`half-edge ${h} has no twin (dangling)`);
    else if (t.heTwin[tw] !== h) errors.push(`half-edge ${h}: twin(twin) mismatch`);
    // Consistent direction: the twin runs the opposite way, and next starts where this one ends.
    if (tw >= 0 && n >= 0 && t.heOrigin[tw] !== t.heOrigin[n]) {
      errors.push(`half-edge ${h}: next does not start at its end vertex`);
    }
    if (t.heEdge[h] < 0) errors.push(`half-edge ${h} has no edge`);
    if (errors.length > 50) break;
  }

  // Face loops close after exactly face.length steps and stay inside the face.
  for (let f = 0; f < t.nF; f++) {
    const len = mesh.faces[f].length;
    let h = t.fHe[f];
    for (let i = 0; i < len; i++) {
      if (t.heFace[h] !== f) {
        errors.push(`face ${f}: loop leaves the face`);
        break;
      }
      if (t.heOrigin[h] !== mesh.faces[f][i]) {
        errors.push(`face ${f}: loop order mismatch`);
        break;
      }
      h = t.heNext[h];
    }
    if (h !== t.fHe[f]) errors.push(`face ${f}: loop does not close`);
  }

  // Every edge has at most 2 faces and they agree on winding (checked via directed edges above).
  const edgeFaceCount = new Map<number, number>();
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const k = edgeKey(f[i], f[(i + 1) % f.length]);
      edgeFaceCount.set(k, (edgeFaceCount.get(k) ?? 0) + 1);
    }
  }
  for (const [k, c] of edgeFaceCount) if (c > 2) errors.push(`edge ${k} has ${c} faces (non-manifold)`);

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** Throws with a readable message if the mesh is invalid. Handy in tests. */
export function assertValid(mesh: MeshData, label = 'mesh'): void {
  const r = validateMesh(mesh);
  if (!r.ok) throw new Error(`${label} is invalid:\n  ${r.errors.slice(0, 10).join('\n  ')}`);
}
