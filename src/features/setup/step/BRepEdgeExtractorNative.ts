// B-Rep Edge Extraction via Native Addon (IPC)

import { OcctChannels } from "src/app/channels/occtChannels";

import type { Vec3 } from "../Setup.type";

import type { BRepEdgeCurve } from "./BRepEdgeExtractor";

// eslint-disable-next-line
const electron = (window as any).electron;

// Native edge_extractor.cpp 가 emit 하는 raw 형식 (type 이 "line" 또는 "other").
// circle/ellipse/bspline 은 type "other" + curveHint + hint metadata 로 부분 표현.
type NativeRawEdge =
  | { type: "line"; start: Vec3; end: Vec3 }
  | {
      type: "other";
      points: Vec3[];
      curveHint?: "circle" | "ellipse" | "bspline";
      hintCenter?: Vec3;
      hintRadius?: number;
      hintAxis?: Vec3;
    };

/** axis 와 수직인 단위 xDir 벡터 — startParam=0 의 reference 방향 (full circle 이라 임의 OK). */
function pickXDirPerpendicular(axis: Vec3): Vec3 {
  // axis 와 가장 안 평행한 world basis 와 cross
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  let ref: Vec3;
  if (ax <= ay && ax <= az) ref = { x: 1, y: 0, z: 0 };
  else if (ay <= ax && ay <= az) ref = { x: 0, y: 1, z: 0 };
  else ref = { x: 0, y: 0, z: 1 };
  // cross(axis, ref) → axis 와 수직
  const x = axis.y * ref.z - axis.z * ref.y;
  const y = axis.z * ref.x - axis.x * ref.z;
  const z = axis.x * ref.y - axis.y * ref.x;
  const len = Math.hypot(x, y, z);
  return len < 1e-12
    ? { x: 1, y: 0, z: 0 }
    : { x: x / len, y: y / len, z: z / len };
}

/**
 * Native raw edge → BRepEdgeCurve 변환.
 * cpp 측이 GeomAbs_Circle 을 식별하고 hintCenter/Radius/Axis 를 보내지만 type 은 "other" 로 emit.
 * 여기서 하나의 정합된 BRepEdgeCurve 표현으로 변환 — 2D projection (BRepEdgeProjector) 과 3D
 * wireframe 양쪽이 정확한 parametric 정보를 사용 가능.
 *
 * 한계: cpp 가 startParam/endParam 을 안 보내므로 trimmed arc (hole 의 일부) 는 full circle 로
 * 들어감. 일반적 STEP 의 round hole / boss 는 full circle 이라 안전. trimmed 처리는 cpp 변경 필요.
 */
function adaptNativeEdge(raw: NativeRawEdge): BRepEdgeCurve {
  if (raw.type === "line") return raw;
  if (raw.curveHint === "circle" && raw.hintCenter && raw.hintRadius && raw.hintAxis) {
    return {
      type: "circle",
      center: raw.hintCenter,
      axis: raw.hintAxis,
      xDir: pickXDirPerpendicular(raw.hintAxis),
      radius: raw.hintRadius,
      startParam: 0,
      endParam: Math.PI * 2,
    };
  }
  // ellipse / bspline / 기타: hint 정보 부족 — sample points 그대로 (polyline fallback).
  return { type: "other", points: raw.points };
}

/**
 * Native Addon으로 B-Rep edge 추출
 */
export async function extractBRepEdgesNative(
  shapeHandle: number,
  excludedSolidIndices?: number[],
): Promise<BRepEdgeCurve[]> {
  const raw: NativeRawEdge[] = await electron.ipcRenderer.invoke(
    OcctChannels.EXTRACT_EDGES,
    shapeHandle,
    excludedSolidIndices ?? [],
  );
  return raw.map(adaptNativeEdge);
}
