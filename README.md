# CAD Editor

A desktop **2D/3D CAD editor** built with Electron — a constraint-based 2D sketcher fused with a 3D solid-modeling viewport. Draw a fully-constrained sketch on a plane, extrude/revolve it into a solid, import STEP models to build on, and step back and forth between 2D and 3D — all with unified undo/redo.

> Extracted and rebuilt as a standalone editor from a larger mechanical-design application. Pure CAD editing only — no backend, no cloud, everything runs locally.

## Features

- **2D constraint sketcher** — lines, arcs, circles, rectangles, splines, points, construction geometry, with a geometric/dimensional constraint solver (coincident, parallel, perpendicular, tangent, equal, distance, angle, radius…) powered by [PlaneGCS](https://github.com/Salusoft89/planegcs).
- **3D viewport** — Three.js scene with orbit/pan/zoom, reference planes, and section views. Switch freely between the 3D model and a 2D section sketch.
- **Solid modeling** — Pad / Pocket / Revolve from sketch profiles, project edges & silhouettes, boolean operations.
- **STEP import** — load `.step` / `.stp` models via OpenCascade (WASM), with an optional C++ OCCT native addon for faster/precise B-Rep operations (see [`packages/occt-native`](packages/occt-native)).
- **Unified history** — a single undo/redo stack across sketch geometry, constraints, and 3D operations.
- **Project files** — save/load work as `.cad` files (JSON), with OS file-association on Windows/macOS.

## Tech stack

| Area | Tech |
|---|---|
| Shell | Electron 35 (Electron Forge) |
| UI | React 19, TypeScript, SCSS/BEM |
| Bundler | Vite 6 |
| State | Jotai |
| 3D | Three.js |
| Constraints | PlaneGCS |
| Geometry kernel | OpenCascade.js (WASM) + optional C++ OCCT native addon |

## Getting started

```bash
npm install      # install dependencies
npm start        # run in development (hot reload)
```

## Build

```bash
npm run package  # build an unpacked app into out/
npm run make     # build platform installers
```

### Optional: C++ native geometry addon

The app runs fully on the WASM geometry kernel out of the box. To build the faster native OCCT addon:

```bash
# requires CMake and an OCCT static build (vcpkg recommended)
npm run build:native
```

See [`packages/occt-native/README.md`](packages/occt-native/README.md) for details.

## Scripts

| Command | Description |
|---|---|
| `npm start` | Development mode (hot reload) |
| `npm run package` | Package the app (unpacked) |
| `npm run make` | Build platform installers |
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`) |
| `npm run lint` | ESLint over `src/` and `test/` |
| `npm run format` | Prettier format |

## License

MIT — see [`LICENSE`](LICENSE).
