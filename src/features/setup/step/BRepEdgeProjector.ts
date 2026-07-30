// B-Rep Edge → 스케치 평면 정확 투영
// BRepEdgeCurve를 SerializedGeometry로 변환 (heuristic 피팅 불필요)

import type { SerializedGeometry, SketchPlane, Vec3 } from "../Setup.type";
import { generateProjectionId } from "../utils/idGenerator";

import type { BRepEdgeCurve } from "./BRepEdgeExtractor";

type Vec2 = { x: number; y: number };

// 3D 점 → 스케치 평면 local UV 좌표 투영
const projectToPlane = (point: Vec3, origin: Vec3, u: Vec3, v: Vec3): Vec2 => {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  return {
    x: dx * u.x + dy * u.y + dz * u.z,
    y: dx * v.x + dy * v.y + dz * v.z,
  };
};

// 중복 제거용 거리 비교
const dist2d = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

const SAMPLES_DEFAULT = 24;

/**
 * B-Rep edge 곡선을 스케치 평면에 투영하여 SerializedGeometry로 변환
 */
export function projectBRepEdge(
  edge: BRepEdgeCurve,
  plane: SketchPlane,
  modelOffset?: Vec3,
): SerializedGeometry | null {
  const off = modelOffset ?? { x: 0, y: 0, z: 0 };
  const { origin, u, v } = plane;

  // edge 좌표(로컬)에 offset 적용하여 plane basis(world)와 동일 좌표계에서 투영
  const proj = (p: Vec3): Vec2 => projectToPlane(
    { x: p.x + off.x, y: p.y + off.y, z: p.z + off.z },
    origin, u, v,
  );

  switch (edge.type) {
    case "line": {
      const p1 = proj(edge.start);
      const p2 = proj(edge.end);
      if (dist2d(p1, p2) < 1e-4) return null; // 퇴화 선분
      return {
        type: "line",
        id: generateProjectionId(),
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        isReference: true,
      };
    }

    case "circle": {
      const center2d = proj(edge.center);
      // 원의 축이 평면 법선과 평행한지 확인
      const normal = {
        x: u.y * v.z - u.z * v.y,
        y: u.z * v.x - u.x * v.z,
        z: u.x * v.y - u.y * v.x,
      };
      const dot = Math.abs(edge.axis.x * normal.x + edge.axis.y * normal.y + edge.axis.z * normal.z);

      if (dot > 0.99) {
        // 원이 평면과 평행 → circle 또는 arc
        const sweep = edge.endParam - edge.startParam;
        if (Math.abs(sweep) >= Math.PI * 2 - 0.01) {
          return {
            type: "circle",
            id: generateProjectionId(),
            cx: center2d.x, cy: center2d.y, r: edge.radius,
            isReference: true,
          };
        } else {
          // arc: startAngle/endAngle 계산
          const startPt = circlePointAt(edge, edge.startParam);
          const endPt = circlePointAt(edge, edge.endParam);
          const p1 = proj(startPt);
          const p2 = proj(endPt);
          const startAngle = Math.atan2(p1.y - center2d.y, p1.x - center2d.x);
          const endAngle = Math.atan2(p2.y - center2d.y, p2.x - center2d.x);
          return {
            type: "arc",
            id: generateProjectionId(),
            cx: center2d.x, cy: center2d.y, r: edge.radius,
            startAngle, endAngle,
            isReference: true,
          };
        }
      }

      // 원이 평면과 거의 수직 (dot < 0.05) → 직선으로 투영
      if (dot < 0.05) {
        const startPt = circlePointAt(edge, edge.startParam);
        const endPt = circlePointAt(edge, edge.endParam);
        const p1 = proj(startPt);
        const p2 = proj(endPt);
        if (dist2d(p1, p2) < 1e-4) return null;
        return {
          type: "line",
          id: generateProjectionId(),
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          isReference: true,
        };
      }

      // 원이 평면과 비스듬 → 샘플링
      return sampleCurveToGeometry(edge, proj, SAMPLES_DEFAULT);
    }

    case "ellipse": {
      // 타원 → 해석적 투영이 복잡하므로 샘플링
      return sampleEllipseToGeometry(edge, proj, SAMPLES_DEFAULT);
    }

    case "bspline": {
      // 직교 투영은 선형 연산이므로 pole 투영 = 곡선 투영 (수학적으로 정확)
      // C++ 측에서 Segment(t0,t1)로 edge 범위로 trim 완료된 상태
      const projectedPoles = edge.poles.map(proj);
      if (projectedPoles.length < 2) return null;
      if (projectedPoles.length === 2 && dist2d(projectedPoles[0], projectedPoles[1]) < 1e-4) return null;

      if (isCollinear(projectedPoles)) {
        const { p1, p2 } = collinearExtent(projectedPoles);
        if (dist2d(p1, p2) < 1e-4) return null;
        return {
          type: "line",
          id: generateProjectionId(),
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          isReference: true,
        };
      }

      // OCCT knot을 0~1로 정규화 (nurbsEvaluate가 t ∈ [0,1]로 평가)
      const normalizedKnots = normalizeKnots(edge.knots, edge.multiplicities);

      return {
        type: "curve",
        id: generateProjectionId(),
        points: projectedPoles,
        degree: edge.degree,
        knots: normalizedKnots,
        weights: edge.weights,
        isReference: true,
      };
    }

    case "other": {
      // 이미 샘플링된 점 → 투영
      const points = edge.points.map(proj);
      if (points.length < 2) return null;
      if (isCollinear(points)) {
        const { p1, p2 } = collinearExtent(points);
        if (dist2d(p1, p2) < 1e-4) return null;
        return {
          type: "line",
          id: generateProjectionId(),
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          isReference: true,
        };
      }
      return {
        type: "curve",
        id: generateProjectionId(),
        points,
        isReference: true,
      };
    }
  }
}

// 원 위의 점 (파라미터 t → 3D 좌표)
function circlePointAt(edge: BRepEdgeCurve & { type: "circle" }, t: number): Vec3 {
  const a = edge.axis;
  const xd = edge.xDir;
  // yd = axis × xDir
  const yd = {
    x: a.y * xd.z - a.z * xd.y,
    y: a.z * xd.x - a.x * xd.z,
    z: a.x * xd.y - a.y * xd.x,
  };
  const c = Math.cos(t), s = Math.sin(t);
  const r = edge.radius;
  return {
    x: edge.center.x + r * (c * xd.x + s * yd.x),
    y: edge.center.y + r * (c * xd.y + s * yd.y),
    z: edge.center.z + r * (c * xd.z + s * yd.z),
  };
}

// 원 → polyline 샘플링 → SerializedGeometry
function sampleCurveToGeometry(
  edge: BRepEdgeCurve & { type: "circle" },
  proj: (p: Vec3) => Vec2,
  samples: number,
): SerializedGeometry | null {
  const points: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = edge.startParam + (i / samples) * (edge.endParam - edge.startParam);
    points.push(proj(circlePointAt(edge, t)));
  }
  if (points.length < 2) return null;
  return {
    type: "curve",
    id: generateProjectionId(),
    points,
    isReference: true,
  };
}

// 타원 → polyline 샘플링
function sampleEllipseToGeometry(
  edge: BRepEdgeCurve & { type: "ellipse" },
  proj: (p: Vec3) => Vec2,
  samples: number,
): SerializedGeometry | null {
  const a = edge.axis;
  const md = edge.majorDir;
  const minorDir = {
    x: a.y * md.z - a.z * md.y,
    y: a.z * md.x - a.x * md.z,
    z: a.x * md.y - a.y * md.x,
  };

  const points: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = edge.startParam + (i / samples) * (edge.endParam - edge.startParam);
    const c = Math.cos(t), s = Math.sin(t);
    const pt: Vec3 = {
      x: edge.center.x + edge.majorRadius * c * md.x + edge.minorRadius * s * minorDir.x,
      y: edge.center.y + edge.majorRadius * c * md.y + edge.minorRadius * s * minorDir.y,
      z: edge.center.z + edge.majorRadius * c * md.z + edge.minorRadius * s * minorDir.z,
    };
    points.push(proj(pt));
  }
  if (points.length < 2) return null;
  return {
    type: "curve",
    id: generateProjectionId(),
    points,
    isReference: true,
  };
}

// OCCT knot vector → 0~1 정규화 (multiplicities 적용 후 flatten)
// nurbsEvaluate는 t ∈ [0,1]에서 평가하므로 knot도 0~1 범위로 매핑
function normalizeKnots(knots: number[], multiplicities?: number[]): number[] {
  // multiplicities로 flatten
  const flat: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const mult = multiplicities?.[i] ?? 1;
    for (let j = 0; j < mult; j++) {
      flat.push(knots[i]);
    }
  }
  // 0~1로 정규화
  const tMin = flat[0];
  const tMax = flat[flat.length - 1];
  const range = tMax - tMin;
  if (range < 1e-15) return flat;
  return flat.map((k) => (k - tMin) / range);
}

// 직선 판별된 점들의 실제 양 끝점 (min/max 투영)
function collinearExtent(pts: Vec2[]): { p1: Vec2; p2: Vec2 } {
  const dx = pts[pts.length - 1].x - pts[0].x;
  const dy = pts[pts.length - 1].y - pts[0].y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // 시작=끝인 경우 (전체 원 등) → 직교 방향으로 min/max
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let minPt = pts[0], maxPt = pts[0];
    for (const p of pts) {
      if (p.x < minX || (p.x === minX && p.y < minY)) { minX = p.x; minY = p.y; minPt = p; }
      if (p.x > maxX || (p.x === maxX && p.y > maxY)) { maxX = p.x; maxY = p.y; maxPt = p; }
    }
    return { p1: minPt, p2: maxPt };
  }
  // 직선 방향으로 투영하여 min/max
  const ux = dx / len, uy = dy / len;
  let minT = Infinity, maxT = -Infinity;
  let minPt = pts[0], maxPt = pts[0];
  for (const p of pts) {
    const t = (p.x - pts[0].x) * ux + (p.y - pts[0].y) * uy;
    if (t < minT) { minT = t; minPt = p; }
    if (t > maxT) { maxT = t; maxPt = p; }
  }
  return { p1: minPt, p2: maxPt };
}

// 점들이 직선인지 판별
function isCollinear(pts: Vec2[]): boolean {
  if (pts.length < 3) return true;
  const dx = pts[pts.length - 1].x - pts[0].x;
  const dy = pts[pts.length - 1].y - pts[0].y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i].x - pts[0].x;
    const py = pts[i].y - pts[0].y;
    const dist = Math.abs(px * (-dy) + py * dx) / len;
    if (dist > Math.max(len * 0.005, 0.01)) return false;
  }
  return true;
}

/**
 * B-Rep edge 목록을 스케치 평면에 투영 + 중복 제거
 */
export function projectBRepEdgesToSketch(
  edges: BRepEdgeCurve[],
  plane: SketchPlane,
  modelOffset?: Vec3,
): SerializedGeometry[] {
  const results: SerializedGeometry[] = [];

  for (const edge of edges) {
    const geom = projectBRepEdge(edge, plane, modelOffset);
    if (geom) results.push(geom);
  }

  return deduplicateGeometries(results);
}

// 간단한 중복 제거
function deduplicateGeometries(geoms: SerializedGeometry[], epsilon = 0.1): SerializedGeometry[] {
  const result: SerializedGeometry[] = [];
  for (const g of geoms) {
    let isDuplicate = false;
    for (const existing of result) {
      if (g.type !== existing.type) continue;
      if (g.type === "line" && existing.type === "line") {
        const d1 = Math.hypot(g.x1 - existing.x1, g.y1 - existing.y1) + Math.hypot(g.x2 - existing.x2, g.y2 - existing.y2);
        const d2 = Math.hypot(g.x1 - existing.x2, g.y1 - existing.y2) + Math.hypot(g.x2 - existing.x1, g.y2 - existing.y1);
        if (Math.min(d1, d2) < epsilon) { isDuplicate = true; break; }
      } else if (g.type === "circle" && existing.type === "circle") {
        if (Math.hypot(g.cx - existing.cx, g.cy - existing.cy) < epsilon && Math.abs(g.r - existing.r) < epsilon) {
          isDuplicate = true; break;
        }
      } else if (g.type === "arc" && existing.type === "arc") {
        if (Math.hypot(g.cx - existing.cx, g.cy - existing.cy) < epsilon && Math.abs(g.r - existing.r) < epsilon
            && Math.abs(g.startAngle - existing.startAngle) < epsilon && Math.abs(g.endAngle - existing.endAngle) < epsilon) {
          isDuplicate = true; break;
        }
      }
    }
    if (!isDuplicate) result.push(g);
  }
  return result;
}
