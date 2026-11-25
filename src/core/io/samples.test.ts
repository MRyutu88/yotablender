// Builds a sample scene through the real core ops and checks the exports. With WRITE_SAMPLES=1
// it also writes blender/samples/* (OBJ, MTL, JSON and the expected counts), which
// blender/verify_obj_import.py imports into Blender to confirm quads/n-gons survive.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { exportObj, parseObj } from './obj';
import { serializeProject } from './projectJson';
import { sampleProject, samplePaintPixel, SAMPLE_TEXTURE_SIZE } from './sample';
import { StackEvaluator } from '../modifiers/stack';
import type { Project } from '../scene/scene';

/**
 * What the Blender add-on must reproduce, per object (blender/verify_addon_import.py compares).
 * `evaluated` is the app's own Mirror → Subdivision result at the viewport level: vertex/face
 * counts, the sum of all vertex positions and (with UVs) the sum of all corner UVs.
 */
export function addonExpectations(p: Project) {
  return {
    images: p.images.map((im) => ({
      name: im.name,
      size: [im.width, im.height],
      // A few texels (x, y from the bottom-left, like Blender's pixels) and their RGBA 0..255.
      samples: [
        [5, 5],
        [40, 5],
        [100, 100],
        [200, 250],
      ].map(([x, y]) => ({ x, y, rgba: samplePaintPixel(x, y) })),
    })),
    objects: p.objects.map((o) => {
      const ev = new StackEvaluator().evaluate(o.mesh, o.modifiers);
      const sum = [0, 0, 0];
      for (let i = 0; i < ev.positions.length; i++) sum[i % 3] += ev.positions[i];
      let uvSum: number[] | null = null, corners = 0;
      for (const f of ev.faces) corners += f.length;
      if (ev.cornerUVs) {
        uvSum = [0, 0];
        for (const u of ev.cornerUVs) for (let i = 0; i < u.length; i++) uvSum[i % 2] += u[i];
      }
      const slotNames = o.materialSlots.map((id) => p.materials.find((m) => m.id === id)!.name);
      return {
        name: o.name,
        verts: o.mesh.vertCount,
        faces: o.mesh.faces.length,
        loose_edges: o.mesh.looseEdges.length,
        sizes: histogram(o.mesh.faces),
        location: o.location,
        rotation_euler: o.rotation_euler,
        scale: o.scale,
        shade_smooth: o.shade_smooth,
        modifiers: o.modifiers.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'drag_levels'))),
        materials: slotNames.map((n) => {
          const m = p.materials.find((x) => x.name === n)!;
          return { name: n, base_color: m.base_color, roughness: m.roughness, metallic: m.metallic };
        }),
        face_materials: matCounts(o.mesh.faces.map((_, i) => slotNames[o.mesh.faceMats?.[i] ?? 0])),
        colors: o.mesh.colors ? { first: o.mesh.colors.slice(0, 4), last: o.mesh.colors.slice(-4) } : null,
        uv_corners: o.mesh.uvs ? o.mesh.uvs.reduce((n, u) => n + u.length / 2, 0) : 0,
        uv_first_face: o.mesh.uvs ? o.mesh.uvs[0] : null,
        texture: o.texture ? p.images.find((im) => im.id === o.texture)!.name : null,
        evaluated: { verts: ev.nV, faces: ev.faces.length, corners, position_sum: sum, uv_sum: uvSum },
      };
    }),
  };
}

const matCounts = (names: string[]) => {
  const h: Record<string, number> = {};
  for (const n of names) h[n] = (h[n] ?? 0) + 1;
  return h;
};

const histogram = (faces: number[][]) => {
  const h: Record<string, number> = {};
  for (const f of faces) h[f.length] = (h[f.length] ?? 0) + 1;
  return h;
};

describe('sample scene exports', () => {
  it('has a painted, unwrapped character with sane expectations', () => {
    const e = addonExpectations(sampleProject());
    const body = e.objects[0];
    expect(body.texture).toBe('Character Body Paint');
    expect(body.uv_corners).toBe(sampleProject().objects[0].mesh.faces.reduce((n, f) => n + f.length, 0));
    expect(body.evaluated.uv_sum).not.toBeNull();
    expect(e.images[0].size).toEqual([SAMPLE_TEXTURE_SIZE, SAMPLE_TEXTURE_SIZE]);
  });

  it('keeps every face size through OBJ', () => {
    const p = sampleProject();
    const { obj, mtl } = exportObj(p, { mtlName: 'yotablender-sample.mtl' });
    const parsed = parseObj(obj);
    const expected = p.objects.map((o) => ({
      name: o.name,
      verts: o.mesh.vertCount,
      faces: o.mesh.faces.length,
      sizes: histogram(o.mesh.faces),
      materials: matCounts(o.mesh.faces.map((_, i) => p.materials.find((m) => m.id === o.materialSlots[o.mesh.faceMats?.[i] ?? 0])!.name)),
      hasColors: !!o.mesh.colors,
      hasUVs: !!o.mesh.uvs,
    }));
    expect(
      parsed.map((o) => ({
        name: o.name,
        verts: o.positions.length / 3,
        faces: o.faces.length,
        sizes: histogram(o.faces),
        materials: matCounts(o.faceMaterials),
        hasColors: !!o.colors,
        hasUVs: !!o.uvs,
      })),
    ).toEqual(expected);
    expect(mtl).toMatch(/newmtl Shirt/);
    // Cone vertex 0 (bottom ring) carries the red paint.
    parsed[2].colors!.slice(0, 3).forEach((c, i) => expect(c).toBeCloseTo([0.8, 0.05, 0.05][i], 4));
    const mirrored = exportObj(p, { applyMirror: true, mtlName: 'yotablender-sample.mtl' });
    if (process.env.WRITE_SAMPLES) {
      const dir = new URL('../../../blender/samples/', import.meta.url);
      mkdirSync(dir, { recursive: true });
      writeFileSync(new URL('yotablender-sample.obj', dir), obj);
      writeFileSync(new URL('yotablender-sample-mirrored.obj', dir), mirrored.obj);
      writeFileSync(new URL('yotablender-sample.mtl', dir), mtl);
      writeFileSync(new URL('yotablender-sample.yblend.json', dir), JSON.stringify(serializeProject(p), null, 1));
      const mirroredParsed = parseObj(mirrored.obj).map((o) => ({
        name: o.name,
        verts: o.positions.length / 3,
        faces: o.faces.length,
        sizes: histogram(o.faces),
        materials: matCounts(o.faceMaterials),
        hasColors: !!o.colors,
        hasUVs: !!o.uvs,
      }));
      writeFileSync(new URL('expected-counts.json', dir), JSON.stringify({ cage: expected, mirrored: mirroredParsed }, null, 1));
      writeFileSync(new URL('expected-addon.json', dir), JSON.stringify(addonExpectations(p), null, 1));
    }
  });
});
