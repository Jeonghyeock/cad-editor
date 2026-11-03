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

/**
 * Native raw edge → BRepEdgeCurve 변환.
 * cpp 측이 GeomAbs_Circle 을 식별하고 hintCenter/Radius/Axis 를 보내지만 type 은 "other" 로 emit.
 * 여기서 하나의 정합된 BRepEdgeCurve 표현으로 변환 — 2D projection (BRepEdgeProjector) 과 3D
 * wireframe 양쪽이 정확한 parametric 정보를 사용 가능.
 *
 * cpp 가 startParam/endParam 을 보내지 않으므로 호의 범위는 points 에서 얻는다. points 는 엣지의 실제 범위
 * [t0, t1] 을 같은 간격으로 샘플한 것이고, hintAxis 는 t0·t0+s/3·t0+2s/3 세 점의 AB×AC 라 점들이 도는 방향의
 * 반시계 축이다. 그래서 첫 점 방향을 xDir(startParam 0)로 두고, 끝 점까지 축 기준 반시계 각을 endParam 으로 쓴다.
 * 범위를 버리고 모두 전체 원으로 만들면 필렛 1/4 호가 와이어프레임·피킹·Project 에서 전체 원이 된다.
 */
function adaptNativeEdge(raw: NativeRawEdge): BRepEdgeCurve {
  if (raw.type === "line") return raw;
  if (raw.curveHint === "circle" && raw.hintCenter && raw.hintRadius && raw.hintAxis) {
    const c = raw.hintCenter;
    const a = raw.hintAxis;
    const first = raw.points[0];
    const last = raw.points[raw.points.length - 1];

    const fx = first.x - c.x, fy = first.y - c.y, fz = first.z - c.z;
    const fLen = Math.hypot(fx, fy, fz);
    const xDir = { x: fx / fLen, y: fy / fLen, z: fz / fLen };
    // yDir = axis × xDir
    const yDir = {
      x: a.y * xDir.z - a.z * xDir.y,
      y: a.z * xDir.x - a.x * xDir.z,
      z: a.x * xDir.y - a.y * xDir.x,
    };
    const ex = last.x - c.x, ey = last.y - c.y, ez = last.z - c.z;
    let sweep = Math.atan2(ex * yDir.x + ey * yDir.y + ez * yDir.z, ex * xDir.x + ey * xDir.y + ez * xDir.z);
    if (sweep <= 0) sweep += Math.PI * 2;
    // 끝 점이 첫 점으로 돌아오면 구멍·보스 같은 전체 원 (각이 0 근처라 위 계산으로는 0 이나 2π 로 갈린다).
    // 2π 에 아주 가까운 것도 전체 원으로 본다. 투영(BRepEdgeProjector)이 전체 원으로 보는 기준(2π − 0.01)과 맞춰,
    // 와이어프레임에만 작은 틈이 남지 않게 한다
    const closed = Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z) < raw.hintRadius * 1e-6
      || sweep >= Math.PI * 2 - 0.01;

    return {
      type: "circle",
      center: c,
      axis: a,
      xDir,
      radius: raw.hintRadius,
      startParam: 0,
      endParam: closed ? Math.PI * 2 : sweep,
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
