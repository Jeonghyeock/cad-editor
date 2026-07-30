// 3D 엣지 → 스케치 평면 투영
// STEP 모델의 face boundary edge를 2D 참조 기하로 변환

import type { SerializedGeometry, SketchPlane, StepModelData, Vec3 } from "../Setup.type";
import { generateProjectionId } from "../utils/idGenerator";

import { chainBoundaryEdges, extractFaceBoundary } from "./FaceBoundaryExtractor";

type Vec2 = { x: number; y: number };

// 3D 점을 스케치 평면의 local UV 좌표로 투영
const projectToPlane = (
  point: Vec3,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
): Vec2 => {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  return {
    x: dx * u.x + dy * u.y + dz * u.z,
    y: dx * v.x + dy * v.y + dz * v.z,
  };
};

// polyline이 닫혀있는지 판별
const isClosed = (pts: Vec2[], epsilon = 1e-4): boolean => {
  if (pts.length < 3) return false;
  const d = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return d < epsilon;
};

// 3점으로 원 피팅 (닫힌 polyline용)
const fitCircle = (pts: Vec2[]): { cx: number; cy: number; r: number } | null => {
  if (pts.length < 3) return null;
  const p1 = pts[0];
  const p2 = pts[Math.floor(pts.length / 3)];
  const p3 = pts[Math.floor(pts.length * 2 / 3)];

  const ax = (p1.x + p2.x) / 2, ay = (p1.y + p2.y) / 2;
  const bx = (p2.x + p3.x) / 2, by = (p2.y + p3.y) / 2;
  const d1x = p2.y - p1.y, d1y = -(p2.x - p1.x);
  const d2x = p3.y - p2.y, d2y = -(p3.x - p2.x);

  const denom = d1x * d2y - d1y * d2x;
  const scale = Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y);
  if (scale < 1e-12 || Math.abs(denom) / scale < 1e-6) return null;

  const t = ((bx - ax) * d2y - (by - ay) * d2x) / denom;
  const cx = ax + t * d1x;
  const cy = ay + t * d1y;
  const r = Math.hypot(p1.x - cx, p1.y - cy);
  if (r < 1e-6) return null;

  // 모든 점이 원 위에 있는지 검사 (tessellation 오차 고려하여 5% 허용)
  for (const p of pts) {
    if (Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) / r > 0.05) return null;
  }
  return { cx, cy, r };
};

// 직선 판별 (모든 점이 시작-끝 선분 위에 있는지)
const fitLine = (pts: Vec2[]): boolean => {
  if (pts.length < 2) return false;
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
};

// 호 피팅 (열린 polyline용)
const fitArc = (pts: Vec2[]): { cx: number; cy: number; r: number; startAngle: number; endAngle: number } | null => {
  if (pts.length < 3) return null;
  const circle = fitCircle(pts);
  if (!circle) return null;

  const startAngle = Math.atan2(pts[0].y - circle.cy, pts[0].x - circle.cx);
  const endAngle = Math.atan2(pts[pts.length - 1].y - circle.cy, pts[pts.length - 1].x - circle.cx);

  return { ...circle, startAngle, endAngle };
};

// 고유 ID 생성
const generateId = (): string => generateProjectionId();

// 2D polyline → SerializedGeometry 변환 (참조 기하)
const polylineToGeometry = (pts: Vec2[]): SerializedGeometry | null => {
  if (pts.length < 2) return null;

  // 직선 판별
  if (fitLine(pts)) {
    return {
      type: "line",
      id: generateId(),
      x1: pts[0].x, y1: pts[0].y,
      x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y,
      isReference: true,
    };
  }

  const closed = isClosed(pts);

  // 닫힌 polyline → 원 판별
  if (closed) {
    const circle = fitCircle(pts);
    if (circle) {
      return {
        type: "circle",
        id: generateId(),
        cx: circle.cx, cy: circle.cy, r: circle.r,
        isReference: true,
      };
    }
  }

  // 열린 polyline → 호 판별
  if (!closed) {
    const arc = fitArc(pts);
    if (arc) {
      return {
        type: "arc",
        id: generateId(),
        cx: arc.cx, cy: arc.cy, r: arc.r,
        startAngle: arc.startAngle, endAngle: arc.endAngle,
        isReference: true,
      };
    }
  }

  // 폴백: Ramer-Douglas-Peucker 간소화 후 curve로 변환
  const simplified = simplifyPolyline(pts, Math.max(0.1, averageEdgeLength(pts) * 0.5));
  // 간소화 후에도 점이 너무 많으면 다운샘플링
  const maxPts = Math.min(30, Math.max(8, Math.ceil(polylineLength(pts) / 5)));
  const finalPts = simplified.length > maxPts ? downsamplePolyline(simplified, maxPts) : simplified;
  return {
    type: "curve",
    id: generateId(),
    points: finalPts,
    isReference: true,
  };
};

// polyline 총 길이
const polylineLength = (pts: Vec2[]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
};

// 평균 edge 길이
const averageEdgeLength = (pts: Vec2[]): number => {
  if (pts.length < 2) return 0;
  return polylineLength(pts) / (pts.length - 1);
};

// Ramer-Douglas-Peucker 간소화
const simplifyPolyline = (pts: Vec2[], epsilon: number): Vec2[] => {
  if (pts.length < 3) return pts;
  // 시작-끝 선분에서 가장 먼 점 찾기
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y;
  const len = Math.hypot(dx, dy);
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const dist = len > 1e-10
      ? Math.abs((pts[i].x - first.x) * (-dy) + (pts[i].y - first.y) * dx) / len
      : Math.hypot(pts[i].x - first.x, pts[i].y - first.y);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = simplifyPolyline(pts.slice(0, maxIdx + 1), epsilon);
  const right = simplifyPolyline(pts.slice(maxIdx), epsilon);
  return [...left.slice(0, -1), ...right];
};

// polyline 다운샘플링 (최대 maxPoints개)
const downsamplePolyline = (pts: Vec2[], maxPoints: number): Vec2[] => {
  if (pts.length <= maxPoints) return pts;
  const result: Vec2[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const t = i / (maxPoints - 1);
    const idx = t * (pts.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, pts.length - 1);
    const frac = idx - lo;
    result.push({
      x: pts[lo].x * (1 - frac) + pts[hi].x * frac,
      y: pts[lo].y * (1 - frac) + pts[hi].y * frac,
    });
  }
  return result;
};

// 중복 기하 제거 (동일 위치의 line/circle/arc 병합)
const deduplicateGeometries = (geoms: SerializedGeometry[], epsilon = 0.1): SerializedGeometry[] => {
  const result: SerializedGeometry[] = [];

  for (const g of geoms) {
    let isDuplicate = false;
    for (const existing of result) {
      if (g.type !== existing.type) continue;

      if (g.type === "line" && existing.type === "line") {
        // 양방향 매칭
        const d1 = Math.hypot(g.x1 - existing.x1, g.y1 - existing.y1) + Math.hypot(g.x2 - existing.x2, g.y2 - existing.y2);
        const d2 = Math.hypot(g.x1 - existing.x2, g.y1 - existing.y2) + Math.hypot(g.x2 - existing.x1, g.y2 - existing.y1);
        if (Math.min(d1, d2) < epsilon) { isDuplicate = true; break; }
      } else if (g.type === "circle" && existing.type === "circle") {
        if (Math.hypot(g.cx - existing.cx, g.cy - existing.cy) < epsilon && Math.abs(g.r - existing.r) < epsilon) {
          isDuplicate = true; break;
        }
      } else if (g.type === "arc" && existing.type === "arc") {
        if (
          Math.hypot(g.cx - existing.cx, g.cy - existing.cy) < epsilon &&
          Math.abs(g.r - existing.r) < epsilon &&
          Math.abs(g.startAngle - existing.startAngle) < epsilon &&
          Math.abs(g.endAngle - existing.endAngle) < epsilon
        ) {
          isDuplicate = true; break;
        }
      }
    }
    if (!isDuplicate) result.push(g);
  }
  return result;
};

/**
 * STEP 모델의 모든 face boundary edge를 스케치 평면에 투영하여 참조 기하 생성
 * @param modelOffset 모델 렌더링 좌표 보정 (InputScene의 auto-center offset)
 */
export const projectModelEdgesToSketch = (
  model: StepModelData,
  sketchPlane: SketchPlane,
  modelOffset?: Vec3,
  excludedBodyIndices?: Set<number>,
): SerializedGeometry[] => {
  const off = modelOffset ?? { x: 0, y: 0, z: 0 };
  const { origin, u, v } = sketchPlane;

  // 제외 body를 건너뛰며 face 인덱스 매핑
  let totalFaces = 0;
  const faceToBody = new Map<number, number>(); // faceId → bodyIndex
  for (let bi = 0; bi < model.bodies.length; bi++) {
    if (excludedBodyIndices?.has(bi)) {
      totalFaces += Math.max(model.bodies[bi].brepFaces.length, 1);
      continue;
    }
    const count = Math.max(model.bodies[bi].brepFaces.length, 1);
    for (let fi = 0; fi < count; fi++) {
      faceToBody.set(totalFaces + fi, bi);
    }
    totalFaces += count;
  }

  const allGeoms: SerializedGeometry[] = [];

  for (let faceId = 0; faceId < totalFaces; faceId++) {
    // 제외된 body의 face는 건너뛰기
    if (excludedBodyIndices && !faceToBody.has(faceId)) continue;
    const boundaries = extractFaceBoundary(model, faceId);
    if (boundaries.length === 0) continue;

    const chains = chainBoundaryEdges(boundaries);

    for (const chain of chains) {
      // 3D → 2D 투영 (model offset 보정)
      const projected: Vec2[] = [];
      for (const pt of chain) {
        const offsetPt: Vec3 = { x: pt.x + off.x, y: pt.y + off.y, z: pt.z + off.z };
        const p2d = projectToPlane(offsetPt, origin, u, v);
        // 중복 점 스킵
        if (projected.length > 0) {
          const prev = projected[projected.length - 1];
          if (Math.hypot(p2d.x - prev.x, p2d.y - prev.y) < 1e-6) continue;
        }
        projected.push(p2d);
      }

      if (projected.length < 2) continue;

      // 투영 후 길이가 매우 짧은 엣지 스킵 (퇴화 투영)
      let totalLen = 0;
      for (let i = 1; i < projected.length; i++) {
        totalLen += Math.hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y);
      }
      if (totalLen < 0.01) continue;

      const geom = polylineToGeometry(projected);
      if (geom) allGeoms.push(geom);
    }
  }

  return deduplicateGeometries(allGeoms);
};
