// Native Addon Boolean/Shape API (IPC)

import { OcctChannels } from "src/app/channels/occtChannels";

import type { SerializedGeometry, SketchPlane, Vec3 } from "../Setup.type";

// eslint-disable-next-line
const electron = (window as any).electron;

export interface NativeMeshResult {
  shapeHandle: number;
  mesh: {
    positions: number[];
    normals: number[];
    indices: number[];
  };
}

// Profile edge data for IPC
function profileToEdgeData(profiles: SerializedGeometry[]) {
  return profiles.map((g) => {
    switch (g.type) {
      case "line": return { type: "line", x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
      case "arc": return { type: "arc", cx: g.cx, cy: g.cy, r: g.r, startAngle: g.startAngle, endAngle: g.endAngle };
      case "circle": return { type: "circle", cx: g.cx, cy: g.cy, r: g.r };
      default: return null;
    }
  }).filter(Boolean);
}

export async function buildPrismNative(
  profiles: SerializedGeometry[],
  plane: SketchPlane,
  depth: number,
  direction: number,
): Promise<NativeMeshResult> {
  return await electron.ipcRenderer.invoke(
    OcctChannels.BUILD_PRISM,
    profileToEdgeData(profiles),
    { origin: plane.origin, u: plane.u, v: plane.v },
    depth,
    direction,
  );
}

export async function buildRevolutionNative(
  profiles: SerializedGeometry[],
  plane: SketchPlane,
  axisOrigin: Vec3,
  axisDir: Vec3,
  angle: number,
): Promise<NativeMeshResult> {
  return await electron.ipcRenderer.invoke(
    OcctChannels.BUILD_REVOLUTION,
    profileToEdgeData(profiles),
    { origin: plane.origin, u: plane.u, v: plane.v },
    axisOrigin,
    axisDir,
    angle,
  );
}

export async function performBooleanNative(
  handle1: number,
  handle2: number,
  operation: "fuse" | "cut",
): Promise<NativeMeshResult> {
  return await electron.ipcRenderer.invoke(OcctChannels.PERFORM_BOOLEAN, handle1, handle2, operation);
}

export async function applyFilletNative(
  shapeHandle: number,
  radius: number,
  edgeIndices?: number[],
): Promise<NativeMeshResult> {
  return await electron.ipcRenderer.invoke(OcctChannels.APPLY_FILLET, shapeHandle, radius, edgeIndices ?? []);
}

export async function applyChamferNative(
  shapeHandle: number,
  distance: number,
  edgeIndices?: number[],
): Promise<NativeMeshResult> {
  return await electron.ipcRenderer.invoke(OcctChannels.APPLY_CHAMFER, shapeHandle, distance, edgeIndices ?? []);
}

export async function applyShellNative(
  shapeHandle: number,
  thickness: number,
  openFaceIndices?: number[],
): Promise<NativeMeshResult> {
  return await electron.ipcRenderer.invoke(OcctChannels.APPLY_SHELL, shapeHandle, thickness, openFaceIndices ?? []);
}

export async function tessellateShapeNative(
  shapeHandle: number,
): Promise<{ positions: number[]; normals: number[]; indices: number[] }> {
  return await electron.ipcRenderer.invoke(OcctChannels.TESSELLATE_SHAPE, shapeHandle);
}
