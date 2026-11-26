// glTF 2.0 reader (.glb, or .gltf with its .bin and images given by `resolve`).
//
// Only what the app can use: triangle/strip/fan primitives (and lines as loose edges), the
// first UV set, the first color set, base color / roughness / metallic and the base color
// texture. The node tree is flattened: each node with a mesh becomes one object with its world
// transform baked in, converted from glTF's Y-up to Z-up as (x, -z, y), like Blender.
// Animation, skins and morph targets are ignored (and reported).

import { multiply, identity, transformPoint, type Mat4 } from '../math/mat4';
import { base64ToBytes } from './png';
import type { MtlMaterial, ObjObject } from './obj';

export interface GltfScene {
  objects: ObjObject[];
  /** Materials keyed by name (`ObjObject.faceMaterials`); `map` is a key into `images`. */
  materials: MtlMaterial[];
  images: Record<string, Uint8Array>;
  warnings: string[];
}

export class GltfError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any -- the glTF JSON is read defensively */
type Json = any;

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGltf(
  bytes: Uint8Array,
  resolve: (uri: string) => Uint8Array | undefined = () => undefined,
): GltfScene {
  const { json: g, bin } = splitGlb(bytes);
  if (!g.asset || String(g.asset.version ?? '').split('.')[0] !== '2')
    throw new GltfError('Only glTF 2.0 files are supported');
  const required: string[] = g.extensionsRequired ?? [];
  const compressed = required.filter(
    (e) => e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression',
  );
  if (compressed.length)
    throw new GltfError('That file is compressed (Draco/Meshopt). Export it again without compression.');

  const warnings: string[] = [];
  const buffers: (Uint8Array | null)[] = (g.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri === undefined) return i === 0 ? bin : null;
    return loadUri(b.uri, resolve);
  });
  const view = (i: number): Uint8Array => {
    const v = g.bufferViews?.[i];
    const buf = v && buffers[v.buffer];
    if (!buf) throw new GltfError('Its .bin data is missing: pick the .bin file too, or use .glb');
    return buf.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  };

  // Accessor → flat number array (normalized integers mapped to 0..1 / -1..1).
  let sparseWarned = false;
  const accessor = (i: number): { data: number[]; n: number } => {
    const a = g.accessors?.[i];
    if (!a) throw new GltfError('That file references a missing accessor');
    const n = COMPONENTS[a.type] ?? 1;
    const out = new Array(a.count * n).fill(0);
    if (a.sparse && !sparseWarned) {
      sparseWarned = true;
      warnings.push('sparse data is not supported, some vertices may be off');
    }
    if (a.bufferView === undefined) return { data: out, n };
    const bytesV = view(a.bufferView);
    const dv = new DataView(bytesV.buffer, bytesV.byteOffset, bytesV.byteLength);
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as number];
    if (!size) throw new GltfError('That file uses an unknown data type');
    const stride = g.bufferViews[a.bufferView].byteStride || size * n;
    const base = a.byteOffset ?? 0;
    const read = (o: number): number => {
      switch (a.componentType) {
        case 5120:
          return a.normalized ? Math.max(dv.getInt8(o) / 127, -1) : dv.getInt8(o);
        case 5121:
          return a.normalized ? dv.getUint8(o) / 255 : dv.getUint8(o);
        case 5122:
          return a.normalized ? Math.max(dv.getInt16(o, true) / 32767, -1) : dv.getInt16(o, true);
        case 5123:
          return a.normalized ? dv.getUint16(o, true) / 65535 : dv.getUint16(o, true);
        case 5125:
          return dv.getUint32(o, true);
        default:
          return dv.getFloat32(o, true);
      }
    };
    if (base + stride * (a.count - 1) + size * n > bytesV.byteLength)
      throw new GltfError('That file is cut short');
    for (let e = 0; e < a.count; e++)
      for (let k = 0; k < n; k++) out[e * n + k] = read(base + e * stride + k * size);
    return { data: out, n };
  };

  // Materials (unique names) and their base color images.
  const images: Record<string, Uint8Array> = {};
  const imageKey = (texIndex: number | undefined): string | undefined => {
    const src = texIndex === undefined ? undefined : g.textures?.[texIndex]?.source;
    const img = src === undefined ? undefined : g.images?.[src];
    if (!img) return undefined;
    const key = img.uri && !img.uri.startsWith('data:') ? img.uri : `#image${src}`;
    if (!(key in images)) {
      try {
        const data = img.bufferView !== undefined ? view(img.bufferView) : loadUri(img.uri, resolve);
        if (data) images[key] = data;
      } catch {
        /* reported by the app as a texture that could not be loaded */
      }
    }
    return key;
  };
  const usedNames = new Set<string>();
  const materials: MtlMaterial[] = (g.materials ?? []).map((m: Json, i: number) => {
    let name = String(m.name ?? '').trim() || `Material ${i}`;
    for (let k = 1; usedNames.has(name); k++)
      name = `${String(m.name ?? '').trim() || 'Material'}.${String(k).padStart(3, '0')}`;
    usedNames.add(name);
    const pbr = m.pbrMetallicRoughness ?? {};
    const f = pbr.baseColorFactor ?? [1, 1, 1, 1];
    return {
      name,
      color: [f[0], f[1], f[2]],
      alpha: f[3] ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      metallic: pbr.metallicFactor ?? 1,
      map: (pbr.baseColorTexture?.texCoord ?? 0) === 0 ? imageKey(pbr.baseColorTexture?.index) : undefined,
    } satisfies MtlMaterial;
  });

  // Walk the default scene (or every root node) with world transforms.
  const nodes: Json[] = g.nodes ?? [];
  const objects: ObjObject[] = [];
  const meshNode = (ni: number, world: Mat4) => {
    const node = nodes[ni];
    const mesh = g.meshes?.[node.mesh];
    if (!mesh) return;
    const o = meshObject(
      mesh,
      world,
      String(node.name ?? '').trim() || String(mesh.name ?? '').trim() || 'Mesh',
    );
    if (o.faces.length || o.lines.length) objects.push(o);
  };
  const visit = (ni: number, parent: Mat4, depth: number) => {
    const node = nodes[ni];
    if (!node || depth > 64) return;
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) meshNode(ni, world);
    for (const c of node.children ?? []) visit(c, world, depth + 1);
  };
  const meshObject = (mesh: Json, world: Mat4, name: string): ObjObject => {
    const o: ObjObject = { name, positions: [], faces: [], lines: [], faceMaterials: [] };
    const uvs: number[][] = [];
    let anyUV = false;
    let smoothVotes = 0,
      flatVotes = 0;
    const flip = det3(world) < 0;
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (prim.attributes?.POSITION === undefined || mode === 0) continue;
      const pos = accessor(prim.attributes.POSITION).data;
      const count = pos.length / 3;
      const base = o.positions.length / 3;
      for (let v = 0; v < count; v++) {
        const [x, y, z] = transformPoint(world, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
        o.positions.push(x, -z, y);
      }
      if (prim.attributes.COLOR_0 !== undefined) {
        const { data, n } = accessor(prim.attributes.COLOR_0);
        if (!o.colors) o.colors = new Array(base * 3).fill(1);
        for (let v = 0; v < count; v++) o.colors.push(data[v * n], data[v * n + 1], data[v * n + 2]);
      } else if (o.colors) for (let v = 0; v < count; v++) o.colors.push(1, 1, 1);
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0).data : null;
      const normals = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL).data : null;
      const index =
        prim.indices !== undefined ? accessor(prim.indices).data : Array.from({ length: count }, (_, i) => i);
      const matName = prim.material !== undefined ? (materials[prim.material]?.name ?? '') : '';

      if (mode === 1 || mode === 2 || mode === 3) {
        const step = mode === 1 ? 2 : 1;
        for (let i = 0; i + 1 < index.length; i += step) o.lines.push([base + index[i], base + index[i + 1]]);
        if (mode === 2 && index.length > 2) o.lines.push([base + index[index.length - 1], base + index[0]]);
        continue;
      }
      const tris: number[][] = [];
      if (mode === 4)
        for (let i = 0; i + 2 < index.length; i += 3) tris.push([index[i], index[i + 1], index[i + 2]]);
      else if (mode === 5)
        for (let i = 0; i + 2 < index.length; i++)
          tris.push(i % 2 ? [index[i + 1], index[i], index[i + 2]] : [index[i], index[i + 1], index[i + 2]]);
      else if (mode === 6)
        for (let i = 1; i + 1 < index.length; i++) tris.push([index[0], index[i], index[i + 1]]);
      for (const t0 of tris) {
        if (t0.some((v) => !(v >= 0 && v < count))) continue;
        const t = flip ? [t0[0], t0[2], t0[1]] : t0;
        o.faces.push(t.map((v) => base + v));
        o.faceMaterials.push(matName);
        // glTF's UV origin is the top left; ours (like Blender's) is the bottom left.
        uvs.push(uv ? t.flatMap((v) => [uv[v * 2], 1 - uv[v * 2 + 1]]) : [0, 0, 0, 0, 0, 0]);
        if (uv) anyUV = true;
        // Smooth when a triangle's corner normals differ (flat shading repeats one normal).
        if (normals) {
          const same = t.every((v) =>
            [0, 1, 2].every((k) => Math.abs(normals[v * 3 + k] - normals[t[0] * 3 + k]) < 1e-3),
          );
          if (same) flatVotes++;
          else smoothVotes++;
        }
      }
    }
    if (anyUV) o.uvs = uvs;
    o.smooth = smoothVotes > flatVotes;
    return o;
  };

  const sceneIndex = g.scene ?? 0;
  const roots: number[] | undefined = g.scenes?.[sceneIndex]?.nodes;
  if (roots) for (const r of roots) visit(r, identity(), 0);
  else if (nodes.length) {
    const child = new Set(nodes.flatMap((n: Json) => n.children ?? []));
    nodes.forEach((_, i) => !child.has(i) && visit(i, identity(), 0));
  } else
    (g.meshes ?? []).forEach((m: Json, i: number) => {
      const o = meshObject(m, identity(), String(m.name ?? '').trim() || `Mesh ${i}`);
      if (o.faces.length || o.lines.length) objects.push(o);
    });

  if (
    g.animations?.length ||
    g.skins?.length ||
    (g.meshes ?? []).some((m: Json) => m.primitives?.some((p: Json) => p.targets?.length))
  )
    warnings.push('animation, armatures and shape keys are not imported');
  return { objects, materials, images, warnings };
}

/** A .glb container (JSON + BIN chunk), or plain .gltf JSON. */
function splitGlb(bytes: Uint8Array): { json: Json; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    const total = Math.min(dv.getUint32(8, true), bytes.length);
    let json: Json = null;
    let bin: Uint8Array | null = null;
    for (let o = 12; o + 8 <= total;) {
      const len = dv.getUint32(o, true),
        type = dv.getUint32(o + 4, true);
      const chunk = bytes.subarray(o + 8, Math.min(o + 8 + len, total));
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
      else if (type === 0x004e4942 && !bin) bin = chunk;
      o += 8 + len;
    }
    if (!json) throw new GltfError('That .glb file has no scene data');
    return { json, bin };
  }
  try {
    return { json: JSON.parse(new TextDecoder().decode(bytes)), bin: null };
  } catch {
    throw new GltfError('That is not a glTF file');
  }
}

function loadUri(uri: string, resolve: (uri: string) => Uint8Array | undefined): Uint8Array | null {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    const meta = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    return meta.endsWith(';base64')
      ? base64ToBytes(body)
      : new TextEncoder().encode(decodeURIComponent(body));
  }
  return resolve(decodeURIComponent(uri)) ?? null;
}

function localMatrix(node: Json): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  // Column-major T * R * S.
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

const det3 = (m: Mat4) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) -
  m[4] * (m[1] * m[10] - m[9] * m[2]) +
  m[8] * (m[1] * m[6] - m[5] * m[2]);
