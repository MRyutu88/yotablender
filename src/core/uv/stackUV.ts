// UVs through the modifier stack. They don't depend on positions, so they are computed once per
// plan. Mirror copies them (corners reversed with the winding; no U/V flip, Blender's default).
// Subdivision interpolates them linearly per face: Blender's Subdivision Surface with
// UV Smooth = None, which the add-on sets so the paint lands where it was painted.

/** Corner UVs of the mirrored faces. `src`/`rev` come from the mirror plan. */
export function mirrorCornerUVs(uvs: number[][], src: Int32Array, rev: Uint8Array): number[][] {
  return Array.from(src, (s, i) => {
    const u = uvs[s];
    if (!rev[i]) return u;
    const k = u.length / 2;
    const out = new Array<number>(u.length);
    for (let c = 0; c < k; c++) {
      out[c * 2] = u[(k - 1 - c) * 2];
      out[c * 2 + 1] = u[(k - 1 - c) * 2 + 1];
    }
    return out;
  });
}

/**
 * One level of linear face-varying subdivision, in the face order of the subdivision plan:
 * corner i of a k-gon becomes the quad [corner i, edge mid i→i+1, center, edge mid i-1→i].
 */
export function subdivideCornerUVs(uvs: number[][]): number[][] {
  const out: number[][] = [];
  for (const u of uvs) {
    const k = u.length / 2;
    let cu = 0, cv = 0;
    for (let i = 0; i < k; i++) {
      cu += u[i * 2];
      cv += u[i * 2 + 1];
    }
    cu /= k;
    cv /= k;
    for (let i = 0; i < k; i++) {
      const n = (i + 1) % k, p = (i + k - 1) % k;
      const ui = u[i * 2], vi = u[i * 2 + 1];
      out.push([ui, vi, (ui + u[n * 2]) / 2, (vi + u[n * 2 + 1]) / 2, cu, cv, (ui + u[p * 2]) / 2, (vi + u[p * 2 + 1]) / 2]);
    }
  }
  return out;
}

export interface RenderSplit {
  /** Render vertex count. */
  nR: number;
  /** Render vertex → evaluated vertex. */
  vert: Uint32Array;
  /** u,v per render vertex. */
  uv: Float32Array;
  /** Render vertex of every face corner (faces in order). */
  cornerVert: Uint32Array;
}

/** Splits evaluated vertices where their corners have different UVs (seams). */
export function splitByUV(faces: number[][], uvs: number[][], nV: number): RenderSplit {
  const head = new Int32Array(nV).fill(-1); // first render vertex per evaluated vertex
  const next: number[] = []; // chain of render vertices sharing an evaluated vertex
  const vert: number[] = [];
  const uv: number[] = [];
  let nCorners = 0;
  for (const f of faces) nCorners += f.length;
  const cornerVert = new Uint32Array(nCorners);
  let c = 0;
  faces.forEach((f, fi) => {
    const u = uvs[fi];
    f.forEach((v, i) => {
      const cu = u[i * 2], cv = u[i * 2 + 1];
      let r = head[v];
      while (r >= 0 && (Math.abs(uv[r * 2] - cu) > 1e-7 || Math.abs(uv[r * 2 + 1] - cv) > 1e-7)) r = next[r];
      if (r < 0) {
        r = vert.length;
        vert.push(v);
        uv.push(cu, cv);
        next.push(head[v]);
        head[v] = r;
      }
      cornerVert[c++] = r;
    });
  });
  return { nR: vert.length, vert: Uint32Array.from(vert), uv: Float32Array.from(uv), cornerVert };
}
