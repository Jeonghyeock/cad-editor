// OCCT Native Addon IPC handlers
// main process에서 @cad-editor/occt-native 로드, renderer는 IPC로 호출

import { app, ipcMain } from "electron";

import { OcctChannels } from "src/app/channels/occtChannels";
import { getOcctAddonCandidates } from "src/app/ipc/occtAddonPath";

import type {
  OcctEdgeData,
  OcctMeshResult,
  OcctPlaneData,
  OcctVec3,
} from "src/shared/types/Occt.type";

// Native addon 로드 (빌드된 .node 파일)
// eslint-disable-next-line
let addon: any = null;

function getAddon() {
  if (addon) return addon;

  // 배포판은 resources 아래 하나만, 개발 실행은 저장소의 빌드 결과를 시도 (cwd 후보는 개발 실행에서만)
  const candidates = getOcctAddonCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? "",
    dirname: __dirname,
    cwd: process.cwd(),
  });

  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      addon = require(p);
      // eslint-disable-next-line no-console
      console.log("[OCCT Native] Loaded from:", p, "version:", addon.getOcctVersion?.());
      return addon;
    } catch {
      // 다음 경로 시도
    }
  }

  // eslint-disable-next-line no-console
  console.warn("[OCCT Native] Addon not found, STEP will use WASM fallback");
  return null;
}

export const registerOcctIpc = () => {
  ipcMain.handle(OcctChannels.PING, () => {
    const oc = getAddon();
    return oc?.ping() ?? "addon not loaded";
  });

  ipcMain.handle(OcctChannels.READ_STEP_FILE, (_event, buffer: ArrayBuffer) => {
    const oc = getAddon();
    if (!oc?.readStepFile) {
      throw new Error("OCCT Native Addon not available");
    }
    const result = oc.readStepFile(Buffer.from(buffer));

    if (result._diag) {
      const d = result._diag;
      console.error( // eslint-disable-line no-console
        `[OCCT Native] Diag: solids=${d.solids}, freeShells=${d.freeShells}, freeFaces=${d.freeFaces}, emptyBodies=${d.emptyBodies}, failed=${d.failedBodies}, extracted=${d.extractedBodies}`,
      );
      if (d.failReasons) {
        for (const reason of d.failReasons) {
          console.error(`[OCCT Native] Fail:`, reason); // eslint-disable-line no-console
        }
      }
    }

    // Float32Array/Uint32Array → 일반 Array로 변환 (IPC structured clone 호환)
    return {
      shapeHandle: result.shapeHandle,
      bodies: result.bodies.map((b: { name: string; color: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array; brepFaces: { first: number; last: number; color?: string }[] }) => ({
        name: b.name,
        color: b.color,
        positions: Array.from(b.positions),
        normals: Array.from(b.normals),
        indices: Array.from(b.indices),
        brepFaces: b.brepFaces,
      })),
    };
  });

  ipcMain.handle(OcctChannels.EXTRACT_EDGES, (_event, shapeHandle: number, excludedIndices?: number[]) => {
    const oc = getAddon();
    if (!oc?.extractEdges) {
      throw new Error("OCCT Native Addon extractEdges not available");
    }
    return oc.extractEdges(shapeHandle, excludedIndices ?? []);
  });

  // addon 측은 native (.node) 라 type 정의 외부. result shape 은 addon API 약속 — 변환.
  const meshResultToJs = (result: { shapeHandle: number; mesh: { positions: ArrayLike<number>; normals: ArrayLike<number>; indices: ArrayLike<number> } }): OcctMeshResult => ({
    handle: result.shapeHandle,
    mesh: {
      positions: Array.from(result.mesh.positions),
      normals: Array.from(result.mesh.normals),
      indices: Array.from(result.mesh.indices),
    },
  });

  ipcMain.handle(OcctChannels.BUILD_PRISM, (_event, profiles: OcctEdgeData[], plane: OcctPlaneData, depth: number, direction: number) => {
    const oc = getAddon();
    if (!oc?.buildPrism) throw new Error("buildPrism not available");
    return meshResultToJs(oc.buildPrism(profiles, plane, depth, direction));
  });

  ipcMain.handle(OcctChannels.BUILD_REVOLUTION, (_event, profiles: OcctEdgeData[], plane: OcctPlaneData, axisOrigin: OcctVec3, axisDir: OcctVec3, angle: number) => {
    const oc = getAddon();
    if (!oc?.buildRevolution) throw new Error("buildRevolution not available");
    return meshResultToJs(oc.buildRevolution(profiles, plane, axisOrigin, axisDir, angle));
  });

  ipcMain.handle(OcctChannels.APPLY_FILLET, (_event, handle: number, radius: number, edgeIndices?: number[]) => {
    const oc = getAddon();
    if (!oc?.applyFillet) throw new Error("applyFillet not available");
    return meshResultToJs(oc.applyFillet(handle, radius, edgeIndices ?? []));
  });

  ipcMain.handle(OcctChannels.APPLY_CHAMFER, (_event, handle: number, distance: number, edgeIndices?: number[]) => {
    const oc = getAddon();
    if (!oc?.applyChamfer) throw new Error("applyChamfer not available");
    return meshResultToJs(oc.applyChamfer(handle, distance, edgeIndices ?? []));
  });

  ipcMain.handle(OcctChannels.APPLY_SHELL, (_event, handle: number, thickness: number, openFaceIndices?: number[]) => {
    const oc = getAddon();
    if (!oc?.applyShell) throw new Error("applyShell not available");
    return meshResultToJs(oc.applyShell(handle, thickness, openFaceIndices ?? []));
  });

  ipcMain.handle(OcctChannels.PERFORM_BOOLEAN, (_event, handle1: number, handle2: number, operation: string) => {
    const oc = getAddon();
    if (!oc?.performBoolean) throw new Error("performBoolean not available");
    return meshResultToJs(oc.performBoolean(handle1, handle2, operation));
  });

  ipcMain.handle(OcctChannels.TESSELLATE_SHAPE, (_event, handle: number) => {
    const oc = getAddon();
    if (!oc?.tessellateShape) throw new Error("tessellateShape not available");
    // eslint-disable-next-line
    const result = oc.tessellateShape(handle);
    return { positions: Array.from(result.positions), normals: Array.from(result.normals), indices: Array.from(result.indices) };
  });

  // --- Phase 1: Sketch → Wire/Face ---

  ipcMain.handle(OcctChannels.MAKE_WIRE_FROM_SKETCH, (_event, edges: OcctEdgeData[], origin: OcctVec3, u: OcctVec3, v: OcctVec3) => {
    const oc = getAddon();
    if (!oc?.makeWireFromSketch) throw new Error("makeWireFromSketch not available");
    return oc.makeWireFromSketch(edges, origin, u, v);
  });

  ipcMain.handle(OcctChannels.MAKE_FACE_FROM_WIRE, (_event, wireHandle: number, holeHandles?: number[]) => {
    const oc = getAddon();
    if (!oc?.makeFaceFromWire) throw new Error("makeFaceFromWire not available");
    return oc.makeFaceFromWire(wireHandle, holeHandles ?? []);
  });

  // --- Phase 1: PartDocument + Feature Tree ---

  ipcMain.handle(OcctChannels.CREATE_DOCUMENT, () => {
    const oc = getAddon();
    if (!oc?.createDocument) throw new Error("createDocument not available");
    return oc.createDocument();
  });

  ipcMain.handle(OcctChannels.RELEASE_DOCUMENT, (_event, docId: number) => {
    getAddon()?.releaseDocument(docId);
  });

  ipcMain.handle(OcctChannels.ADD_SKETCH_FEATURE, (_event, docId: number, faceHandle: number) => {
    const oc = getAddon();
    if (!oc?.addSketchFeature) throw new Error("addSketchFeature not available");
    return oc.addSketchFeature(docId, faceHandle);
  });

  ipcMain.handle(OcctChannels.ADD_PAD_FEATURE, (_event, docId: number, faceHandle: number, depth: number, direction: OcctVec3) => {
    const oc = getAddon();
    if (!oc?.addPadFeature) throw new Error("addPadFeature not available");
    return oc.addPadFeature(docId, faceHandle, depth, direction);
  });

  ipcMain.handle(OcctChannels.ADD_POCKET_FEATURE, (_event, docId: number, faceHandle: number, depth: number, direction: OcctVec3) => {
    const oc = getAddon();
    if (!oc?.addPocketFeature) throw new Error("addPocketFeature not available");
    return oc.addPocketFeature(docId, faceHandle, depth, direction);
  });

  ipcMain.handle(OcctChannels.ADD_REVOLVE_FEATURE, (_event, docId: number, faceHandle: number, angle: number, axisOrigin: OcctVec3, axisDir: OcctVec3) => {
    const oc = getAddon();
    if (!oc?.addRevolveFeature) throw new Error("addRevolveFeature not available");
    return oc.addRevolveFeature(docId, faceHandle, angle, axisOrigin, axisDir);
  });

  ipcMain.handle(OcctChannels.ADD_FILLET_FEATURE, (_event, docId: number, radius: number, edgeIndices: number[]) => {
    const oc = getAddon();
    if (!oc?.addFilletFeature) throw new Error("addFilletFeature not available");
    return oc.addFilletFeature(docId, radius, edgeIndices);
  });

  ipcMain.handle(OcctChannels.ADD_CHAMFER_FEATURE, (_event, docId: number, distance: number, edgeIndices: number[]) => {
    const oc = getAddon();
    if (!oc?.addChamferFeature) throw new Error("addChamferFeature not available");
    return oc.addChamferFeature(docId, distance, edgeIndices);
  });

  ipcMain.handle(OcctChannels.GET_FEATURE_TREE, (_event, docId: number) => {
    const oc = getAddon();
    if (!oc?.getFeatureTree) throw new Error("getFeatureTree not available");
    return oc.getFeatureTree(docId);
  });

  ipcMain.handle(OcctChannels.UPDATE_FEATURE, (_event, ...args: unknown[]) => {
    const oc = getAddon();
    if (!oc?.updateFeature) throw new Error("updateFeature not available");
    return oc.updateFeature(...args);
  });

  ipcMain.handle(OcctChannels.REMOVE_FEATURE, (_event, ...args: unknown[]) => {
    const oc = getAddon();
    if (!oc?.removeFeature) throw new Error("removeFeature not available");
    return oc.removeFeature(...args);
  });

  ipcMain.handle(OcctChannels.GET_SHAPE_TOPOLOGY, (_event, handle: number) => {
    const oc = getAddon();
    if (!oc?.getShapeTopology) throw new Error("getShapeTopology not available");
    return oc.getShapeTopology(handle);
  });

  ipcMain.handle(OcctChannels.EXPORT_STEP, (_event, handle: number, filePath: string) => {
    const oc = getAddon();
    if (!oc?.exportStep) throw new Error("exportStep not available");
    return oc.exportStep(handle, filePath);
  });

  ipcMain.handle(OcctChannels.EXPORT_IGES, (_event, handle: number, filePath: string) => {
    const oc = getAddon();
    if (!oc?.exportIges) throw new Error("exportIges not available");
    return oc.exportIges(handle, filePath);
  });

  // Phase 5: Document serialization
  // eslint-disable-next-line
  ipcMain.handle(OcctChannels.SERIALIZE_DOCUMENT, (_event, docId: number) => {
    const oc = getAddon();
    if (!oc?.serializeDocument) throw new Error("serializeDocument not available");
    return oc.serializeDocument(docId);
  });

  ipcMain.handle(OcctChannels.DESERIALIZE_DOCUMENT, (_event, data: string | Uint8Array) => {
    const oc = getAddon();
    if (!oc?.deserializeDocument) throw new Error("deserializeDocument not available");
    return oc.deserializeDocument(data);
  });

  // Phase 4: Topology picking
  ipcMain.handle(OcctChannels.TESSELLATE_SHAPE_WITH_TOPOLOGY, (_event, handle: number) => {
    const oc = getAddon();
    if (!oc?.tessellateShapeWithTopology) throw new Error("tessellateShapeWithTopology not available");
    // eslint-disable-next-line
    const result = oc.tessellateShapeWithTopology(handle);
    return {
      positions: Array.from(result.positions),
      normals: Array.from(result.normals),
      indices: Array.from(result.indices),
      faceGroups: result.faceGroups,
    };
  });
};
