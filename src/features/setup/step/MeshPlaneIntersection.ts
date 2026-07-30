// Mesh-Plane 교차 알고리즘
// 삼각형 메시와 평면의 교차선(segment)을 계산

import type { Vec3 } from "../Setup.type";

export type IntersectionSegment = {
  a: Vec3;
  b: Vec3;
};

/**
 * mesh triangle들과 평면의 교차 segment를 계산
 *
 * @param positions flat xyz vertex 배열
 * @param indices triangle index 배열
 * @param planeOrigin 평면 원점
 * @param planeNormal 평면 법선 (정규화)
 * @param startIndex 처리 시작 인덱스 (faceGroup용)
 * @param count 처리할 인덱스 수 (faceGroup용)
 */
export const computeMeshPlaneIntersection = (
  positions: number[],
  indices: number[],
  planeOrigin: Vec3,
  planeNormal: Vec3,
  startIndex = 0,
  count = indices.length,
): IntersectionSegment[] => {
  const segments: IntersectionSegment[] = [];

  const end = Math.min(startIndex + count, indices.length);

  for (let i = startIndex; i + 2 < end; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    const v0: Vec3 = { x: positions[i0], y: positions[i0 + 1], z: positions[i0 + 2] };
    const v1: Vec3 = { x: positions[i1], y: positions[i1 + 1], z: positions[i1 + 2] };
    const v2: Vec3 = { x: positions[i2], y: positions[i2 + 1], z: positions[i2 + 2] };

    // 각 정점과 평면의 부호 거리
    const d0 = dot(sub(v0, planeOrigin), planeNormal);
    const d1 = dot(sub(v1, planeOrigin), planeNormal);
    const d2 = dot(sub(v2, planeOrigin), planeNormal);

    const intersections: Vec3[] = [];

    // 각 edge에 대해 교점 계산
    const edges: [Vec3, Vec3, number, number][] = [
      [v0, v1, d0, d1],
      [v1, v2, d1, d2],
      [v2, v0, d2, d0],
    ];

    for (const [va, vb, da, db] of edges) {
      if (Math.sign(da) !== Math.sign(db) && da !== 0 && db !== 0) {
        const t = da / (da - db);
        intersections.push({
          x: va.x + t * (vb.x - va.x),
          y: va.y + t * (vb.y - va.y),
          z: va.z + t * (vb.z - va.z),
        });
      } else if (Math.abs(da) < 1e-10 && Math.abs(db) >= 1e-10) {
        intersections.push({ ...va });
      } else if (Math.abs(db) < 1e-10 && Math.abs(da) >= 1e-10) {
        intersections.push({ ...vb });
      }
    }

    if (intersections.length >= 2) {
      segments.push({ a: intersections[0], b: intersections[1] });
    }
  }

  return segments;
};

/**
 * segment 리스트를 epsilon 매칭으로 polyline으로 체이닝
 */
export const chainSegments = (
  segments: IntersectionSegment[],
  epsilon = 1e-6,
): Vec3[][] => {
  if (segments.length === 0) return [];

  const used = new Array(segments.length).fill(false);
  const chains: Vec3[][] = [];

  const near = (a: Vec3, b: Vec3) =>
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.z - b.z) < epsilon;

  for (let seed = 0; seed < segments.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;

    const chain: Vec3[] = [segments[seed].a, segments[seed].b];
    let changed = true;

    while (changed) {
      changed = false;
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const s = segments[i];
        const tail = chain[chain.length - 1];
        const head = chain[0];

        if (near(tail, s.a)) {
          chain.push(s.b);
          used[i] = true;
          changed = true;
        } else if (near(tail, s.b)) {
          chain.push(s.a);
          used[i] = true;
          changed = true;
        } else if (near(head, s.b)) {
          chain.unshift(s.a);
          used[i] = true;
          changed = true;
        } else if (near(head, s.a)) {
          chain.unshift(s.b);
          used[i] = true;
          changed = true;
        }
      }
    }

    chains.push(chain);
  }

  return chains;
};

// 벡터 유틸 (인라인)
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;
