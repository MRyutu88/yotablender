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
- **Export:** OBJ + MTL (cage with quads/n-gons, per-face materials, vertex colors) and the
  native `.yblend.json` project (modifiers, transforms, slots, colors) for the Blender add-on.
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

## Blender

- `blender/verify_obj_import.py` imports `blender/samples/*.obj` into Blender and checks that
  every object, its face sizes, per-face materials and vertex colors survive. Regenerate the samples with
  `WRITE_SAMPLES=1 npx vitest run samples`.
- `blender/make_subdiv_fixtures.py` regenerates the subdivision golden data used by the tests.
- Import our OBJ in Blender with File → Import → Wavefront (.obj), default settings.

## Layout

`src/core` (pure TS, no Three.js/DOM: mesh, ops, subdivision, modifiers, IO), `src/render`
(Three.js), `src/input` (gestures), `src/app` (operators, undo, autosave), `src/ui` (Preact).
