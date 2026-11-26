# YotaBlender

A touch-first low-poly character modeler for phones (an installable PWA) with a Blender round-trip.

**Live app: https://mryutu88.github.io/yotablender/**

## Install on the phone (works offline)

1. Open the link above in Chrome on the phone.
2. Menu ⋮ → **Add to Home screen** → **Install** (or use **Install app** in the app's ☰ menu).
3. Open it once while online; a "Ready to work offline" message confirms the offline copy.
   After that it runs with no connection. Projects are saved on the phone automatically.
4. Every push to `main` deploys a new version; the app shows **Reload** when one is ready.

## What it does

- **Object Mode:** primitives (cube, quad sphere, UV sphere, cylinder, cone, torus, plane) and a
  "Character start" (half box with Mirror + Subdivision); move/rotate/scale, duplicate, outliner.
- **Edit Mode** (vertex / edge / face): extrude, inset, loop cut, merge, delete; select
  linked / loop / ring (double-tap an edge for its loop); proportional editing.
- **Modifiers:** Mirror (axes, clipping, merge) → Subdivision Surface, matching Blender 5.3's results.
- **Materials:** slots per object, per-face assignment, base color / roughness / metallic,
  Solid or Material preview shading.
- **Vertex Paint:** draw, blur and pick colors into a "Color" attribute (Vertex domain).
- **Texture Paint:** Paint mode → **Texture**. One tap unwraps the object automatically (like
  Blender's Smart UV Project) and adds a paint texture (512/1K/2K). Draw, Erase, Pick, Fill; the
  paint sits on top of the object's colors. Strokes cross UV seams cleanly and, with Mirror,
  paint both halves at once. Edits keep the UVs (loop cut/inset interpolate, extrude stretches);
  ⋯ → Unwrap again re-unwraps, Export PNG shares the texture.
- **Export:** OBJ + MTL (cage with quads/n-gons, per-face materials, vertex colors, UVs, and a
  flattened PNG per painted object) and the native `.yblend.json` project (modifiers, transforms,
  slots, colors, UVs, paint textures) for the Blender add-on.
- **Import OBJ** (☰ → Import): the .obj with its .mtl and textures, or a .zip of them. Keeps quads/n-gons,
  materials, vertex colors, UVs and one texture per object (becomes its paint texture, up to 2K).
  Split vertices are welded, flipped faces turned around, broken/non-manifold faces removed; huge or
  tiny models are scaled to fit. Limits: 25 MB, 20,000 faces, 32 objects.
- Undo/redo for everything, autosave on the device, works offline.

## Develop

```
npm install
npm run dev      # serves on your Wi-Fi: open http://<PC-IP>:5173 on the phone
npm test         # unit tests for the mesh core (incl. Blender 5.3 golden data)
npm run build    # production build with service worker (offline)
```

Phone over Wi-Fi: PC and phone on the same network, open `http://<PC-IP>:5173` in Chrome.
Install and offline need HTTPS. To test them on the dev server, open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the phone and add the address,
or use the GitHub Pages build (`.github/workflows/deploy.yml` deploys on every push to `main`).

## Blender add-on (File → Import → YotaBlender)

Imports `.yblend.json` projects into Blender 4.2+ (tested on 5.3) with everything the app knows:
the exact cage (quads, n-gons, loose edges), location/rotation/scale, shade smooth, the
Mirror → Subdivision Surface stack with the same settings, Principled BSDF materials with
per-face assignment, the "Color" attribute (optionally wired into the materials), the "UVMap"
and the paint texture (packed into the .blend, mixed over the base color by its alpha).
Objects with UVs get Subdivision "UV Smooth: None", which matches how the app interpolates UVs,
so the paint lands exactly where you painted it.

Install: download `yotablender_import.zip` from the app's ☰ menu (or
https://mryutu88.github.io/yotablender/yotablender_import.zip), then in Blender
Edit → Preferences → Get Extensions → ⌄ → **Install from Disk…** and pick the zip.
`npm run addon` builds the same zip into `blender/dist/`. The source is in
`blender/addon/yotablender_import/`.

## Blender checks

- `blender/verify_addon_import.py` imports `blender/samples/yotablender-sample.yblend.json` with
  the add-on (straight from the repo, or the installed one with `YB_USE_OPERATOR = True`) in a
  temporary scene and compares everything with `blender/samples/expected-addon.json`, including
  the subdivided vertex count, position sum and UV sum computed by the app itself.
- `blender/verify_obj_import.py` imports `blender/samples/*.obj` into Blender and checks that
  every object, its face sizes, per-face materials and vertex colors survive. Regenerate the samples with
  `WRITE_SAMPLES=1 npx vitest run samples`.
- `blender/make_subdiv_fixtures.py` regenerates the subdivision golden data used by the tests.
- Import our OBJ in Blender with File → Import → Wavefront (.obj), default settings (keep the PNGs
  next to the OBJ/MTL, or use the zip export).

## Layout

`src/core` (pure TS, no Three.js/DOM: mesh, ops, subdivision, modifiers, UV unwrap, IO incl. PNG),
`src/render` (Three.js, incl. GPU texture painting), `src/input` (gestures), `src/app` (operators,
undo, autosave), `src/ui` (Preact), `blender/addon` (the Blender extension).
