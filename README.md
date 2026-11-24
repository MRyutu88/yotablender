# YotaBlender

A touch-first low-poly character modeler for phones (an installable PWA) with a Blender round-trip.

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
  every object and its face sizes survive. Regenerate the samples with
  `WRITE_SAMPLES=1 npx vitest run samples`.
- `blender/make_subdiv_fixtures.py` regenerates the subdivision golden data used by the tests.
- Import our OBJ in Blender with File → Import → Wavefront (.obj), default settings.

## Layout

`src/core` (pure TS, no Three.js/DOM: mesh, ops, subdivision, modifiers, IO), `src/render`
(Three.js), `src/input` (gestures), `src/app` (operators, undo, autosave), `src/ui` (Preact).
