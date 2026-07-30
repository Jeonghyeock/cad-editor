// 3D 단면 결과 → 2D 좌표 변환
// 평면 local UV 좌표계 구성

import type { Vec3 } from "../Setup.type";

import type { CrossSectionResult } from "./CrossSectionComputer";

type Vec2 = { x: number; y: number };

/**
 * 평면의 local 좌표계(U, V) 구성
 */
export const buildPlaneCoordSystem = (
  normal: Vec3,
): { u: Vec3; v: Vec3 } => {
  // up 힌트 벡터 선택
  const upHint: Vec3 =
    Math.abs(normal.y) < 0.9
      ? { x: 0, y: 1, z: 0 }
      : { x: 1, y: 0, z: 0 };

  // U = normalize(cross(upHint, normal))
  const u = normalize(cross(upHint, normal));
  // V = normalize(cross(normal, U))
  const v = normalize(cross(normal, u));

  return { u, v };
};

/**
 * 3D 점을 평면 local 좌표로 투영
 */
const projectToPlane = (
  point: Vec3,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
): Vec2 => {
  const d: Vec3 = {
    x: point.x - origin.x,
    y: point.y - origin.y,
    z: point.z - origin.z,
  };
  return {
    x: d.x * u.x + d.y * u.y + d.z * u.z,
    y: d.x * v.x + d.y * v.y + d.z * v.z,
  };
};

export type ProjectedPolyline = Vec2[];

/**
 * CrossSectionResult → 2D polyline 변환
 */
export const projectCrossSectionTo2D = (
  result: CrossSectionResult,
): ProjectedPolyline[] => {
  const { polylines, planeOrigin, planeNormal } = result;
  const { u, v } = buildPlaneCoordSystem(planeNormal);

  const projected: ProjectedPolyline[] = [];

  for (const polyline of polylines) {
    const points: Vec2[] = [];
    for (let i = 0; i < polyline.length; i++) {
      const p = projectToPlane(polyline[i], planeOrigin, u, v);
      // 중복 점 스킵
      if (i > 0 && Math.hypot(p.x - points[points.length - 1].x, p.y - points[points.length - 1].y) < 1e-6) {
        continue;
      }
      points.push(p);
    }
    if (points.length >= 2) {
      projected.push(points);
    }
  }

  return projected;
};

// 벡터 연산 (인라인)
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-10) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};
