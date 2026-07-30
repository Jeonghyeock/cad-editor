// 기하 요소 간 교차점 계산 유틸리티
// Trim/Fillet/Chamfer 도구에서 사용

import type { SerializedGeometry } from "../Setup.type";
import { isAngleBetween, normalizeAngle } from "../utils/mathUtils";

// 교차점 결과
export type IntersectionResult = {
  x: number;
  y: number;
  t: number;        // target 기하의 파라미터 (0~1 for line, angle for arc)
  otherGeomId: string;
};

// 두 선분의 교차점 계산 (파라미터 포함)
export function lineLineIntersection(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): { x: number; y: number; t1: number; t2: number } | null {
  const dx1 = ax2 - ax1, dy1 = ay2 - ay1;
  const dx2 = bx2 - bx1, dy2 = by2 - by1;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null; // 평행
  const t1 = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / denom;
  const t2 = ((bx1 - ax1) * dy1 - (by1 - ay1) * dx1) / denom;
  return { x: ax1 + t1 * dx1, y: ay1 + t1 * dy1, t1, t2 };
}

// 선분과 원의 교차점 (선분 범위 내만)
// includeEndpoints=true면 선분 endpoint가 원 위에 닿는 경우도 포함 (trim용)
export function lineCircleIntersection(
  x1: number, y1: number, x2: number, y2: number,
  cx: number, cy: number, r: number,
  includeEndpoints = false,
): { x: number; y: number; t: number }[] {
  const dx = x2 - x1, dy = y2 - y1;
  const fx = x1 - cx, fy = y1 - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-12) return [];

  const EPS = 1e-9;
  const lo = includeEndpoints ? -EPS : EPS;
  const hi = includeEndpoints ? 1 + EPS : 1 - EPS;
  const results: { x: number; y: number; t: number }[] = [];
  const sqrtDisc = Math.sqrt(disc);
  for (const sign of [-1, 1]) {
    const t = (-b + sign * sqrtDisc) / (2 * a);
    if (t > lo && t < hi) {
      results.push({ x: x1 + t * dx, y: y1 + t * dy, t });
    }
  }
  return results;
}

// 선분과 호의 교차점 (호 각도 범위 내만)
export function lineArcIntersection(
  x1: number, y1: number, x2: number, y2: number,
  cx: number, cy: number, r: number,
  startAngle: number, endAngle: number,
): { x: number; y: number; t: number }[] {
  const raw = lineCircleIntersection(x1, y1, x2, y2, cx, cy, r);
  return raw.filter((pt) => {
    const angle = normalizeAngle(Math.atan2(pt.y - cy, pt.x - cx));
    return isAngleBetween(angle, normalizeAngle(startAngle), normalizeAngle(endAngle));
  });
}

// 선분과 호의 교차점 (선분 endpoint 포함 — trim용)
function lineArcIntersectionInclusive(
  x1: number, y1: number, x2: number, y2: number,
  cx: number, cy: number, r: number,
  startAngle: number, endAngle: number,
): { x: number; y: number; t: number }[] {
  const raw = lineCircleIntersection(x1, y1, x2, y2, cx, cy, r, true);
  return raw.filter((pt) => {
    const angle = normalizeAngle(Math.atan2(pt.y - cy, pt.x - cx));
    return isAngleBetween(angle, normalizeAngle(startAngle), normalizeAngle(endAngle));
  });
}

// target 기하와 나머지 모든 기하의 교차점 → t 기준 정렬 반환
export function findAllIntersections(
  targetGeom: SerializedGeometry,
  allGeometries: Map<string, SerializedGeometry>,
): IntersectionResult[] {
  const results: IntersectionResult[] = [];

  for (const [id, other] of allGeometries) {
    if (id === targetGeom.id) continue;
    if ("isReference" in other && other.isReference) continue;
    if ("isConstruction" in other && other.isConstruction) continue;

    const pts = intersectGeometries(targetGeom, other);
    for (const pt of pts) {
      results.push({ ...pt, otherGeomId: id });
    }
  }

  // t 파라미터 기준 정렬
  results.sort((a, b) => a.t - b.t);
  return results;
}

// 두 기하의 교차점 계산 (target 기하의 t 파라미터 포함)
function intersectGeometries(
  target: SerializedGeometry,
  other: SerializedGeometry,
): { x: number; y: number; t: number }[] {
  if (target.type === "line" && other.type === "line") {
    const hit = lineLineIntersection(
      target.x1, target.y1, target.x2, target.y2,
      other.x1, other.y1, other.x2, other.y2,
    );
    if (!hit) return [];
    // target 선분의 내부(strict interior)에서만 교차 인정
    // other 선분은 endpoint 포함 (닿는 것도 trim 경계)
    const EPS = 1e-9;
    if (hit.t1 > EPS && hit.t1 < 1 - EPS && hit.t2 >= -EPS && hit.t2 <= 1 + EPS) {
      return [{ x: hit.x, y: hit.y, t: hit.t1 }];
    }
    return [];
  }

  if (target.type === "line" && other.type === "circle") {
    // target line은 strict interior, other circle 둘레와의 교차
    // 선분 파라미터 strict (target endpoint 제외) + circle 둘레는 항상 유효
    return lineCircleIntersection(
      target.x1, target.y1, target.x2, target.y2,
      other.cx, other.cy, other.r,
    );
  }

  if (target.type === "line" && other.type === "arc") {
    return lineArcIntersection(
      target.x1, target.y1, target.x2, target.y2,
      other.cx, other.cy, other.r,
      other.startAngle, other.endAngle,
    );
  }

  if (target.type === "circle" && other.type === "line") {
    // other line의 endpoint가 circle 위에 닿는 경우도 포함
    const pts = lineCircleIntersection(
      other.x1, other.y1, other.x2, other.y2,
      target.cx, target.cy, target.r,
      true,
    );
    // t를 circle의 각도 파라미터로 변환
    return pts.map((pt) => ({
      x: pt.x, y: pt.y,
      t: normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx)),
    }));
  }

  // circle-circle 교차
  if (target.type === "circle" && other.type === "circle") {
    const pts = circleCircleIntersection(target.cx, target.cy, target.r, other.cx, other.cy, other.r);
    return pts.map((pt) => ({
      x: pt.x, y: pt.y,
      t: normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx)),
    }));
  }

  // circle-arc 교차
  if (target.type === "circle" && other.type === "arc") {
    const pts = circleCircleIntersection(target.cx, target.cy, target.r, other.cx, other.cy, other.r);
    return pts.filter((pt) => {
      const angle = normalizeAngle(Math.atan2(pt.y - other.cy, pt.x - other.cx));
      return isAngleBetween(angle, normalizeAngle(other.startAngle), normalizeAngle(other.endAngle));
    }).map((pt) => ({
      x: pt.x, y: pt.y,
      t: normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx)),
    }));
  }

  // arc-circle 교차
  if (target.type === "arc" && other.type === "circle") {
    const pts = circleCircleIntersection(target.cx, target.cy, target.r, other.cx, other.cy, other.r);
    return pts.filter((pt) => {
      const angle = normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx));
      return isAngleBetween(angle, normalizeAngle(target.startAngle), normalizeAngle(target.endAngle));
    }).map((pt) => ({
      x: pt.x, y: pt.y,
      t: arcParameterize(normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx)), target.startAngle, target.endAngle),
    }));
  }

  // arc-arc 교차
  if (target.type === "arc" && other.type === "arc") {
    const pts = circleCircleIntersection(target.cx, target.cy, target.r, other.cx, other.cy, other.r);
    return pts.filter((pt) => {
      const aTarget = normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx));
      const aOther = normalizeAngle(Math.atan2(pt.y - other.cy, pt.x - other.cx));
      return isAngleBetween(aTarget, normalizeAngle(target.startAngle), normalizeAngle(target.endAngle)) &&
             isAngleBetween(aOther, normalizeAngle(other.startAngle), normalizeAngle(other.endAngle));
    }).map((pt) => ({
      x: pt.x, y: pt.y,
      t: arcParameterize(normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx)), target.startAngle, target.endAngle),
    }));
  }

  if (target.type === "arc" && other.type === "line") {
    // other line의 endpoint가 arc 위에 닿는 경우도 포함
    const pts = lineArcIntersectionInclusive(
      other.x1, other.y1, other.x2, other.y2,
      target.cx, target.cy, target.r,
      target.startAngle, target.endAngle,
    );
    // t를 arc 내부 정규화 파라미터로 변환 (0~1)
    return pts.map((pt) => {
      const angle = normalizeAngle(Math.atan2(pt.y - target.cy, pt.x - target.cx));
      return { x: pt.x, y: pt.y, t: arcParameterize(angle, target.startAngle, target.endAngle) };
    });
  }

  return [];
}

// arc 내부 파라미터 (0~1)
function arcParameterize(angle: number, start: number, end: number): number {
  const s = normalizeAngle(start);
  const e = normalizeAngle(end);
  const a = normalizeAngle(angle);
  const span = s <= e ? e - s : (Math.PI * 2 - s + e);
  let delta = a - s;
  if (delta < 0) delta += Math.PI * 2;
  return span > 1e-9 ? delta / span : 0;
}

// 두 원의 교차점 (0, 1, 또는 2개)
function circleCircleIntersection(
  cx1: number, cy1: number, r1: number,
  cx2: number, cy2: number, r2: number,
): { x: number; y: number }[] {
  const dx = cx2 - cx1, dy = cy2 - cy1;
  const d = Math.hypot(dx, dy);

  // 너무 멀거나 동심 → 교차 없음
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9 || d < 1e-9) return [];

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - a * a;
  if (hSq < -1e-9) return [];
  const h = Math.sqrt(Math.max(0, hSq));

  // 중점 (두 원의 교차 중심선 위)
  const mx = cx1 + a * dx / d;
  const my = cy1 + a * dy / d;

  if (h < 1e-9) {
    // 접선 (1개)
    return [{ x: mx, y: my }];
  }

  // 2개 교차점
  const px = -dy / d * h;
  const py = dx / d * h;
  return [
    { x: mx + px, y: my + py },
    { x: mx - px, y: my - py },
  ];
}

// 두 직선의 교차점 (무한 연장) — Fillet/Chamfer에서 사용
export function lineLineIntersectionUnbounded(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): { x: number; y: number; t1: number; t2: number } | null {
  const dx1 = ax2 - ax1, dy1 = ay2 - ay1;
  const dx2 = bx2 - bx1, dy2 = by2 - by1;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const t1 = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / denom;
  const t2 = ((bx1 - ax1) * dy1 - (by1 - ay1) * dx1) / denom;
  return { x: ax1 + t1 * dx1, y: ay1 + t1 * dy1, t1, t2 };
}
