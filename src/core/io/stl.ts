// STL reader (binary and ASCII). STL is a list of triangles with their own copies of every
// vertex and no units, materials or UVs; welding and quad joining happen in the importer.

export interface StlSolid {
  /** The ASCII `solid` name ('' for binary files and unnamed solids). */
  name: string;
  /** Unwelded positions, 3 per corner. */
  positions: number[];
  faces: number[][];
}

export function parseStl(bytes: Uint8Array): StlSolid[] {
  if (isBinary(bytes)) return [readBinary(bytes)];
  const text = new TextDecoder().decode(bytes);
  if (/^\s*solid\b/.test(text)) return readAscii(text);
  if (bytes.length >= 84) return [readBinary(bytes)];
  throw new Error('That is not an STL file');
}

/** Binary when the size matches the triangle count (ASCII files can start with "solid" too, and some binary ones do). */
function isBinary(b: Uint8Array): boolean {
  if (b.length < 84) return false;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  return 84 + n * 50 === b.length;
}

function readBinary(b: Uint8Array): StlSolid {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // Trust the data that is there when the count disagrees with the file size.
  const n = Math.min(dv.getUint32(80, true), Math.floor((b.length - 84) / 50));
  const positions: number[] = new Array(n * 9);
  const faces: number[][] = new Array(n);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12; // skip the stored normal
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    faces[t] = [t * 3, t * 3 + 1, t * 3 + 2];
  }
  return { name: '', positions, faces };
}

function readAscii(text: string): StlSolid[] {
  const solids: StlSolid[] = [];
  let cur: StlSolid | null = null;
  let loop: number[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [tag, ...rest] = line.split(/\s+/);
    switch (tag.toLowerCase()) {
      case 'solid':
        cur = { name: line.slice(5).trim(), positions: [], faces: [] };
        solids.push(cur);
        break;
      case 'outer':
        loop = [];
        break;
      case 'vertex':
        if (loop) {
          if (!cur) solids.push((cur = { name: '', positions: [], faces: [] }));
          loop.push(cur.positions.length / 3);
          cur.positions.push(...rest.slice(0, 3).map(Number));
        }
        break;
      case 'endloop':
        // Some exporters write polygons with more than 3 vertices per facet.
        if (cur && loop && loop.length >= 3) cur.faces.push(loop);
        loop = null;
        break;
    }
  }
  return solids.filter((s) => s.faces.length);
}
