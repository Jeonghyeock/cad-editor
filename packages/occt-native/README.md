# @cad-editor/occt-native

CAD Editor용 OCCT C++ Electron Native Addon.

STEP import, B-Rep edge 추출, Boolean 연산, Fillet/Chamfer/Shell 등을
C++ 네이티브 코드로 처리하여 WASM 대비 성능과 정확도를 향상.

## 빌드 요구사항

- Node.js >= 18
- CMake >= 3.15
- C++17 컴파일러 (MSVC 2019+, GCC 9+, Clang 10+)
- OCCT 7.9.x 정적 라이브러리

## 빌드

```bash
# OCCT 설치 (vcpkg 권장)
vcpkg install opencascade:x64-windows-static

# 프로젝트 루트에서 빌드
npm run build:native

# 또는 직접 빌드
cd packages/occt-native
npx cmake-js compile --CDOCCT_ROOT=C:/vcpkg/installed/x64-windows-static
```

## API

renderer 측 wrapper 는 `src/features/setup/step/` 의 `OcctSketchNative.ts` / `BooleanNative.ts` 등을 사용. main process IPC 핸들러는 `src/app/channels/occtChannels.ts` 의 `OcctChannels` 상수 기반.

**Shape lifecycle**
- `ping()`, `getOcctVersion()` — 헬스 체크.
- `readStepFile(buffer)` — STEP import → tessellated bodies + shapeHandle.
- `releaseShape(handle)` / `releaseAllShapes()` — handle 해제.
- `tessellateShape(handle)` / `tessellateShapeWithTopology(handle)` — handle → mesh.
- `extractEdges(handle, excludedIdx[])` — B-Rep edge (line/circle/ellipse/bspline/other).
- `getShapeTopology(handle)` / `getDetailedShapeTopology(handle)` — face/edge/vertex 토폴로지.

**Sketch → Solid 파이프라인**
- `makeWireFromShape(shape, geoms, plane)` / `makeFaceFromShape(...)` / `makeFaceFromWire(wire, holes[])`.
- `buildPrismNative(profileGeoms, plane, depth, dir)` — Pad/Pocket 의 한 prism (한 sketch 의 한 profile).
- `performBooleanNative(a, b, "fuse" | "cut" | "common")` — boolean.

**Feature tree (B-Rep 파이프라인)**
- `createDocument()` / `releaseDocument(docId)`.
- `addSketchFeature(docId, faceHandle)`.
- `addPadFeature(docId, faceHandle, depth, normal)` / `addPocketFeature(...)`.
- `addRevolveFeature(docId, faceHandle, angle, axisOrigin, axisDir)`.
- `addFilletFeature(docId, radius, edgeIndices[])` / `addChamferFeature(docId, distance, edgeIndices[])`.
- `updateFeature(docId, featureId, params)` / `removeFeature(docId, featureId)`.
- `getFeatureTree(docId)` — feature dependency 그래프.
- `serializeDocument(docId)` / `deserializeDocument(data)` — file save/load round-trip.
- `exportStep(handle, filePath)` — STEP export.

## Phase 로드맵

- [x] Phase 0: 빌드 환경 + ping() 검증
- [x] Phase 1: STEP import (occt-import-js 대체)
- [x] Phase 2: B-Rep edge 추출 (opencascade.js 대체)
- [x] Phase 3: Boolean 연산 (`buildPrismNative` + `performBooleanNative` — three-bvh-csg 는 fallback 으로만)
- [x] Phase 4: Fillet/Chamfer (`addFilletFeature` / `addChamferFeature`) + Pad/Pocket/Revolve feature tree
- [ ] Phase 5: Shell / Sweep / Pattern (미구현)
