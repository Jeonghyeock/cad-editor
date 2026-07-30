// OCCT Sketch Builder — renderer측 IPC wrapper
// 스케치 기하 → OCCT Wire/Face, PartDocument 관리

import { OcctChannels } from "src/app/channels/occtChannels";

import type { SerializedGeometry, SketchPlane } from "../Setup.type";
import type { SketchShape } from "../sketch/shapeDetector";

// eslint-disable-next-line
const electron = (window as any).electron;

// --- Sketch → Wire/Face ---

/** 스케치 기하 edge 데이터 → OCCT edgeData 형식 변환 */
function geomToEdgeData(geom: SerializedGeometry): object | null {
  switch (geom.type) {
    case "line":
      return { type: "line", x1: geom.x1, y1: geom.y1, x2: geom.x2, y2: geom.y2 };
    case "arc":
      return { type: "arc", cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: geom.startAngle, endAngle: geom.endAngle };
    case "circle":
      return { type: "circle", cx: geom.cx, cy: geom.cy, r: geom.r };
    default:
      return null;
  }
}

/** plane을 IPC용 객체로 변환 */
function planeToVec3(plane: SketchPlane) {
  return {
    origin: plane.origin,
    u: plane.u,
    v: plane.v,
  };
}

/** Wire handle + hole Wire handles → OCCT Face handle */
export async function makeFaceFromWire(
  wireHandle: number,
  holeWireHandles: number[] = [],
): Promise<number> {
  return await electron.ipcRenderer.invoke(
    OcctChannels.MAKE_FACE_FROM_WIRE,
    wireHandle,
    holeWireHandles,
  );
}

/** SketchShape → OCCT Wire handle (lineIds에서 기하 수집 → edge data) */
export async function makeWireFromShape(
  shape: SketchShape,
  geometries: Map<string, SerializedGeometry>,
  plane: SketchPlane,
): Promise<number> {
  const edgeDataList: object[] = [];
  for (const lineId of shape.lineIds) {
    const geom = geometries.get(lineId);
    if (!geom) continue;
    const data = geomToEdgeData(geom);
    if (data) edgeDataList.push(data);
  }

  if (edgeDataList.length === 0) {
    throw new Error("No valid edges for wire");
  }

  const { origin, u, v } = planeToVec3(plane);
  return await electron.ipcRenderer.invoke(
    OcctChannels.MAKE_WIRE_FROM_SKETCH,
    edgeDataList,
    origin,
    u,
    v,
  );
}

/** SketchShape → OCCT Face handle (Wire 생성 + holes 포함) */
export async function makeFaceFromShape(
  shape: SketchShape,
  geometries: Map<string, SerializedGeometry>,
  plane: SketchPlane,
): Promise<number> {
  const wireHandle = await makeWireFromShape(shape, geometries, plane);

  const holeHandles: number[] = [];
  for (const hole of shape.holes) {
    try {
      const holeWire = await makeWireFromShape(hole, geometries, plane);
      holeHandles.push(holeWire);
    } catch {
      // hole 생성 실패 시 스킵
    }
  }

  return await makeFaceFromWire(wireHandle, holeHandles);
}

// --- PartDocument ---

export async function createDocument(): Promise<number> {
  return await electron.ipcRenderer.invoke(OcctChannels.CREATE_DOCUMENT);
}

export async function releaseDocument(docId: number): Promise<void> {
  await electron.ipcRenderer.invoke(OcctChannels.RELEASE_DOCUMENT, docId);
}

export async function addSketchFeature(docId: number, faceHandle: number): Promise<{ featureId: string; outputHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.ADD_SKETCH_FEATURE, docId, faceHandle);
}

export async function addPadFeature(
  docId: number,
  faceHandle: number,
  depth: number,
  direction: { x: number; y: number; z: number },
): Promise<{ featureId: string; outputHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.ADD_PAD_FEATURE, docId, faceHandle, depth, direction);
}

export async function addPocketFeature(
  docId: number,
  faceHandle: number,
  depth: number,
  direction: { x: number; y: number; z: number },
): Promise<{ featureId: string; outputHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.ADD_POCKET_FEATURE, docId, faceHandle, depth, direction);
}

export async function addFilletFeature(
  docId: number,
  radius: number,
  edgeIndices: number[],
): Promise<{ featureId: string; outputHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.ADD_FILLET_FEATURE, docId, radius, edgeIndices);
}

export async function addChamferFeature(
  docId: number,
  distance: number,
  edgeIndices: number[],
): Promise<{ featureId: string; outputHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.ADD_CHAMFER_FEATURE, docId, distance, edgeIndices);
}

export async function addRevolveFeature(
  docId: number,
  faceHandle: number,
  angle: number,
  axisOrigin: { x: number; y: number; z: number },
  axisDir: { x: number; y: number; z: number },
): Promise<{ featureId: string; outputHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.ADD_REVOLVE_FEATURE, docId, faceHandle, angle, axisOrigin, axisDir);
}

export async function updateFeature(
  docId: number,
  featureId: string,
  params: Record<string, unknown>,
): Promise<{ featureId: string; outputHandle: number; lastSolidHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.UPDATE_FEATURE, docId, featureId, params);
}

export async function removeFeature(
  docId: number,
  featureId: string,
): Promise<{ lastSolidHandle: number }> {
  return await electron.ipcRenderer.invoke(OcctChannels.REMOVE_FEATURE, docId, featureId);
}

export async function getFeatureTree(docId: number): Promise<{
  id: string;
  type: string;
  inputHandle: number;
  outputHandle: number;
  depth?: number;
  radius?: number;
  distance?: number;
  angle?: number;
  direction?: { x: number; y: number; z: number };
  axisOrigin?: { x: number; y: number; z: number };
  axisDir?: { x: number; y: number; z: number };
  edgeIndices?: number[];
}[]> {
  return await electron.ipcRenderer.invoke(OcctChannels.GET_FEATURE_TREE, docId);
}

/** @deprecated getDetailedShapeTopology를 사용 — 동일 채널, 상세 타입 */
export async function getShapeTopology(handle: number): Promise<ShapeTopologyData> {
  return await electron.ipcRenderer.invoke(OcctChannels.GET_SHAPE_TOPOLOGY, handle);
}

export async function tessellateShape(handle: number): Promise<{
  positions: number[];
  normals: number[];
  indices: number[];
}> {
  return await electron.ipcRenderer.invoke(OcctChannels.TESSELLATE_SHAPE, handle);
}

export async function exportStep(handle: number, filePath: string): Promise<boolean> {
  return await electron.ipcRenderer.invoke(OcctChannels.EXPORT_STEP, handle, filePath);
}

// --- Phase 5: Document serialization ---

export type SerializedOcctDocument = {
  features: {
    id: string;
    type: string;
    inputHandle: number;
    outputHandle: number;
    depth: number;
    angle: number;
    radius: number;
    distance: number;
    dirX: number; dirY: number; dirZ: number;
    axisOriginX: number; axisOriginY: number; axisOriginZ: number;
    axisDirX: number; axisDirY: number; axisDirZ: number;
    edgeIndices: number[];
  }[];
  nextFeatureId: number;
  shapes: Record<string, string>; // handle → BRep string
};

export async function serializeDocument(docId: number): Promise<SerializedOcctDocument> {
  return await electron.ipcRenderer.invoke(OcctChannels.SERIALIZE_DOCUMENT, docId);
}

export async function deserializeDocument(data: SerializedOcctDocument): Promise<number> {
  return await electron.ipcRenderer.invoke(OcctChannels.DESERIALIZE_DOCUMENT, data);
}

// --- Phase 4: Topology picking ---

export type TopologyEdge = {
  index: number;
  curveType: string;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  mid: { x: number; y: number; z: number };
  polyline: { x: number; y: number; z: number }[];
};

export type TopologyFace = {
  index: number;
  surfaceType: string;
  center: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
};

export type TopologyVertex = {
  index: number;
  x: number;
  y: number;
  z: number;
};

export type ShapeTopologyData = {
  edges: TopologyEdge[];
  faces: TopologyFace[];
  vertices: TopologyVertex[];
  edgeCount: number;
  faceCount: number;
  vertexCount: number;
};

export async function getDetailedShapeTopology(handle: number): Promise<ShapeTopologyData> {
  return await electron.ipcRenderer.invoke(OcctChannels.GET_SHAPE_TOPOLOGY, handle);
}

export type FaceGroupedMesh = {
  positions: number[];
  normals: number[];
  indices: number[];
  faceGroups: { first: number; count: number }[];
};

export async function tessellateShapeWithTopology(handle: number): Promise<FaceGroupedMesh> {
  return await electron.ipcRenderer.invoke(OcctChannels.TESSELLATE_SHAPE_WITH_TOPOLOGY, handle);
}
