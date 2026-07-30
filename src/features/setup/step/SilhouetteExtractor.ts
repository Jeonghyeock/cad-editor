// 메시 기반 Silhouette Edge 추출
// 인접 삼각형의 법선이 투영 방향에 대해 부호가 바뀌는 edge를 찾음

import type { SerializedGeometry, SketchPlane, StepModelData, Vec3 } from "../Setup.type";
import { generateProjectionId } from "../utils/idGenerator";

type Vec2 = { x: number; y: number };

const projectToPlane = (point: Vec3, origin: Vec3, u: Vec3, v: Vec3): Vec2 => {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  return {
    x: dx * u.x + dy * u.y + dz * u.z,
    y: dx * v.x + dy * v.y + dz * v.z,
  };
};

// 위치 기반 vertex key (0.001 tolerance로 같은 위치 vertex 통합)
const PRECISION = 1000;
const vtxKey = (x: number, y: number, z: number): string =>
  `${Math.round(x * PRECISION)}_${Math.round(y * PRECISION)}_${Math.round(z * PRECISION)}`;

const posEdgeKey = (k1: string, k2: string): string =>
  k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;

// 2D 점 key (투영 후)
const PK = 1000;
const pt2dKey = (p: Vec2): string => `${Math.round(p.x * PK)}_${Math.round(p.y * PK)}`;

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
    if (dist > Math.max(len * 0.005, 0.05)) return false;
  }
  return true;
}

/**
 * 메시에서 silhouette edge를 추출하여 스케치 평면에 투영
 */
export function extractSilhouetteFromMesh(
  model: StepModelData,
  plane: SketchPlane,
  projDir: Vec3,
  modelOffset: Vec3,
  excludedBodies?: Set<number>,
): SerializedGeometry[] {
  const { origin, u, v } = plane;

  // 1단계: 모든 body에서 silhouette edge segment 수집 (2D 투영)
  const segments: { p1: Vec2; p2: Vec2 }[] = [];
  const bodySegCounts: number[] = [];

  for (let bodyIdx = 0; bodyIdx < model.bodies.length; bodyIdx++) {
    if (excludedBodies?.has(bodyIdx)) { bodySegCounts.push(0); continue; }
    bodySegCounts.push(0);
    const body = model.bodies[bodyIdx];
    const { positions, indices } = body;
    if (!positions || !indices || indices.length < 3) continue;

    const triCount = Math.floor(indices.length / 3);
    const edgeToTris = new Map<string, { dots: number[]; v1Idx: number; v2Idx: number }>();

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const x0 = positions[i0 * 3], y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
      const x1 = positions[i1 * 3], y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];
      const x2 = positions[i2 * 3], y2 = positions[i2 * 3 + 1], z2 = positions[i2 * 3 + 2];

      const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const dot = nx * projDir.x + ny * projDir.y + nz * projDir.z;

      const k0 = vtxKey(x0, y0, z0), k1 = vtxKey(x1, y1, z1), k2 = vtxKey(x2, y2, z2);
      const edges: [string, string, number, number][] = [[k0, k1, i0, i1], [k1, k2, i1, i2], [k2, k0, i2, i0]];

      for (const [ka, kb, ia, ib] of edges) {
        const ek = posEdgeKey(ka, kb);
        const entry = edgeToTris.get(ek);
        if (entry) entry.dots.push(dot);
        else edgeToTris.set(ek, { dots: [dot], v1Idx: ia, v2Idx: ib });
      }
    }

    for (const [, entry] of edgeToTris) {
      if (entry.dots.length < 2) continue;
      // 부호 판별: threshold로 0 근처도 silhouette 후보에 포함
      const DOT_THRESHOLD = 1e-6;
      let hasPos = false, hasNeg = false;
      for (const d of entry.dots) {
        if (d > DOT_THRESHOLD) hasPos = true;
        else if (d < -DOT_THRESHOLD) hasNeg = true;
      }
      if (!hasPos || !hasNeg) continue;

      const { v1Idx: ia, v2Idx: ib } = entry;
      const p1 = projectToPlane(
        { x: positions[ia * 3] + modelOffset.x, y: positions[ia * 3 + 1] + modelOffset.y, z: positions[ia * 3 + 2] + modelOffset.z },
        origin, u, v,
      );
      const p2 = projectToPlane(
        { x: positions[ib * 3] + modelOffset.x, y: positions[ib * 3 + 1] + modelOffset.y, z: positions[ib * 3 + 2] + modelOffset.z },
        origin, u, v,
      );
      if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 1e-4) continue;
      segments.push({ p1, p2 });
      bodySegCounts[bodySegCounts.length - 1]++;
    }

    // 0 segment인 body 진단
    if (bodySegCounts[bodySegCounts.length - 1] === 0) {
      let _totalEdges = 0, _singleEdges = 0, _matchedEdges = 0, _signChangeEdges = 0;
      for (const [, entry] of edgeToTris) {
        _totalEdges++;
        if (entry.dots.length < 2) _singleEdges++;
        else {
          _matchedEdges++;
          let hp = false, hn = false;
          for (const d of entry.dots) { if (d > 1e-6) hp = true; else if (d < -1e-6) hn = true; }
          if (hp && hn) _signChangeEdges++;
        }
      }
    }
  }



  if (segments.length === 0) return [];

  // 2단계: segment를 체인으로 연결
  // 끝점이 같은 segment를 연결하여 polyline 생성
  const pointToSegs = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const k1 = pt2dKey(segments[i].p1);
    const k2 = pt2dKey(segments[i].p2);
    if (!pointToSegs.has(k1)) pointToSegs.set(k1, []);
    if (!pointToSegs.has(k2)) pointToSegs.set(k2, []);
    pointToSegs.get(k1)!.push(i);
    pointToSegs.get(k2)!.push(i);
  }

  const used = new Set<number>();
  const chains: Vec2[][] = [];

  for (let startIdx = 0; startIdx < segments.length; startIdx++) {
    if (used.has(startIdx)) continue;
    used.add(startIdx);

    const chain: Vec2[] = [segments[startIdx].p1, segments[startIdx].p2];

    // 앞쪽으로 확장
    let extending = true;
    while (extending) {
      extending = false;
      const endKey = pt2dKey(chain[chain.length - 1]);
      const neighbors = pointToSegs.get(endKey);
      if (!neighbors) break;
      for (const ni of neighbors) {
        if (used.has(ni)) continue;
        used.add(ni);
        const seg = segments[ni];
        const sk1 = pt2dKey(seg.p1), sk2 = pt2dKey(seg.p2);
        if (sk1 === endKey) { chain.push(seg.p2); extending = true; break; }
        if (sk2 === endKey) { chain.push(seg.p1); extending = true; break; }
      }
    }

    // 뒤쪽으로 확장
    extending = true;
    while (extending) {
      extending = false;
      const startKey = pt2dKey(chain[0]);
      const neighbors = pointToSegs.get(startKey);
      if (!neighbors) break;
      for (const ni of neighbors) {
        if (used.has(ni)) continue;
        used.add(ni);
        const seg = segments[ni];
        const sk1 = pt2dKey(seg.p1), sk2 = pt2dKey(seg.p2);
        if (sk1 === startKey) { chain.unshift(seg.p2); extending = true; break; }
        if (sk2 === startKey) { chain.unshift(seg.p1); extending = true; break; }
      }
    }

    if (chain.length >= 2) chains.push(chain);
  }

  // 3단계: 체인 → SerializedGeometry

  const results: SerializedGeometry[] = [];
  for (const chain of chains) {
    if (chain.length < 2) continue;

    // 체인의 실제 범위 (bounding box 대각선)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of chain) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const extent = Math.hypot(maxX - minX, maxY - minY);
    if (extent < 0.01) continue;

    if (isCollinear(chain)) {
      // 직선: min/max 범위로 양 끝점
      const bestDir = maxX - minX > maxY - minY ? "x" : "y";
      let p1 = chain[0], p2 = chain[0];
      if (bestDir === "x") {
        for (const p of chain) {
          if (p.x < p1.x) p1 = p;
          if (p.x > p2.x) p2 = p;
        }
      } else {
        for (const p of chain) {
          if (p.y < p1.y) p1 = p;
          if (p.y > p2.y) p2 = p;
        }
      }
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 0.01) continue;
      results.push({
        type: "line",
        id: generateProjectionId(),
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        isReference: true,
      });
    } else if (chain.length >= 4) {
      // 비공선 체인: NURBS curve(degree 3)로 단일 기하 출력 (CATIA silhouette 스타일)
      // 너무 조밀하면 다운샘플링 (최대 ~50 제어점)
      const maxPoints = 50;
      const step = Math.max(1, Math.floor(chain.length / maxPoints));
      const points: Vec2[] = [];
      for (let i = 0; i < chain.length; i += step) points.push(chain[i]);
      const lastChainPt = chain[chain.length - 1];
      const lastPushedPt = points[points.length - 1];
      if (lastPushedPt !== lastChainPt) points.push(lastChainPt);
      results.push({
        type: "curve",
        id: generateProjectionId(),
        points,
        degree: 3,
        isReference: true,
      });
    } else {
      // 짧은 비공선 체인은 line segment로 폴백
      for (let i = 0; i < chain.length - 1; i++) {
        const seg1 = chain[i], seg2 = chain[i + 1];
        if (Math.hypot(seg2.x - seg1.x, seg2.y - seg1.y) < 1e-4) continue;
        results.push({
          type: "line",
          id: generateProjectionId(),
          x1: seg1.x, y1: seg1.y, x2: seg2.x, y2: seg2.y,
          isReference: true,
        });
      }
    }
  }


  return results;
}
