// SerializedGeometry → THREE.Shape 변환 유틸리티
// Pad/Pocket 돌출에 사용할 닫힌 프로파일 생성

import * as THREE from "three";

import type { SerializedGeometry } from "../Setup.type";
import type { SketchShape } from "../sketch/shapeDetector";
import { getShapeVerticesFromGeometries } from "../sketch/shapeDetector";

const ARC_SEGMENTS = 48;

// 닫힌 기하를 THREE.Shape으로 변환
export const geometryToShape = (geom: SerializedGeometry): THREE.Shape | null => {
  switch (geom.type) {
    case "circle": {
      const shape = new THREE.Shape();
      shape.absarc(geom.cx, geom.cy, geom.r, 0, Math.PI * 2, false);
      return shape;
    }
    case "curve": {
      if (geom.points.length < 3) return null;
      // 폐곡선 여부 확인 (시작점 ≈ 끝점)
      const first = geom.points[0];
      const last = geom.points[geom.points.length - 1];
      const dist = Math.hypot(last.x - first.x, last.y - first.y);
      if (dist > 1e-3) return null; // 열린 곡선은 돌출 불가

      const shape = new THREE.Shape();
      shape.moveTo(first.x, first.y);
      for (let i = 1; i < geom.points.length; i++) {
        shape.lineTo(geom.points[i].x, geom.points[i].y);
      }
      return shape;
    }
    case "arc": {
      // 원호를 닫힌 부채꼴로 변환 (중심 → 호 → 중심)
      let sweep = geom.endAngle - geom.startAngle;
      if (sweep <= 0) sweep += Math.PI * 2;
      // 완전한 원에 가까우면 원으로 처리
      if (Math.abs(sweep - Math.PI * 2) < 1e-4) {
        const shape = new THREE.Shape();
        shape.absarc(geom.cx, geom.cy, geom.r, 0, Math.PI * 2, false);
        return shape;
      }
      // 부채꼴 형태
      const shape = new THREE.Shape();
      shape.moveTo(geom.cx, geom.cy);
      const segments = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * ARC_SEGMENTS));
      for (let i = 0; i <= segments; i++) {
        const angle = geom.startAngle + (i / segments) * sweep;
        shape.lineTo(
          geom.cx + geom.r * Math.cos(angle),
          geom.cy + geom.r * Math.sin(angle),
        );
      }
      shape.lineTo(geom.cx, geom.cy);
      return shape;
    }
    case "ellipse": {
      // THREE.EllipseCurve로 Shape 생성
      const curve = new THREE.EllipseCurve(
        geom.cx, geom.cy, geom.rx, geom.ry,
        0, Math.PI * 2, false, geom.rotation,
      );
      const pts = curve.getPoints(ARC_SEGMENTS);
      const shape = new THREE.Shape(pts);
      return shape;
    }
    case "polygon": {
      if (geom.vertices.length < 3) return null;
      const shape = new THREE.Shape();
      shape.moveTo(geom.vertices[0].x, geom.vertices[0].y);
      for (let i = 1; i < geom.vertices.length; i++) {
        shape.lineTo(geom.vertices[i].x, geom.vertices[i].y);
      }
      shape.closePath();
      return shape;
    }
    default:
      // point, line은 닫힌 면적이 없으므로 돌출 불가
      return null;
  }
};

/** SketchShape → THREE.Shape 변환 (lineIds의 기하를 순서대로 이어서 Shape 생성) */
export const sketchShapeToThreeShape = (
  sketchShape: SketchShape,
  geometries: Map<string, SerializedGeometry>,
): THREE.Shape | null => {
  // circle/ellipse 단독: geometryToShape 위임
  if (sketchShape.lineIds.length === 1) {
    const geom = geometries.get(sketchShape.lineIds[0]);
    if (geom) return geometryToShape(geom);
    return null;
  }

  const verts = getShapeVerticesFromGeometries(sketchShape, geometries);
  if (verts.length < 3) return null;

  const shape = new THREE.Shape();
  shape.moveTo(verts[0].x, verts[0].y);
  for (let i = 1; i < verts.length; i++) {
    shape.lineTo(verts[i].x, verts[i].y);
  }
  shape.closePath();
  return shape;
};

// Shape의 부호 면적 계산 (CCW = 양수)
const computeShapeArea = (shape: THREE.Shape): number => {
  const pts = shape.getPoints();
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];
    area += curr.x * next.y - next.x * curr.y;
  }
  return area / 2;
};

// 점이 다각형 내부에 있는지 판별 (ray-casting)
const isPointInShape = (px: number, py: number, shape: THREE.Shape): boolean => {
  const pts = shape.getPoints();
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
};

// shapeB의 모든 꼭짓점이 shapeA 내부에 있는지 검사
const isShapeContainedIn = (inner: THREE.Shape, outer: THREE.Shape): boolean => {
  const innerPts = inner.getPoints();
  // 모든 꼭짓점이 outer 안에 있어야 포함
  return innerPts.every(p => isPointInShape(p.x, p.y, outer));
};

// hole 처리된 Shape + 원본 기하 ID
export type ExtrudableShape = {
  shape: THREE.Shape;
  geomId: string;       // outer shape의 원본 기하 ID
  holeGeomIds: string[]; // hole로 할당된 기하 ID 목록
};

// 여러 기하에서 돌출 가능한 Shape 목록 추출 (포함 관계 → hole 처리)
// depth-parity 방식: 짝수 깊이 = solid, 홀수 깊이 = hole
// NOTE: edge 교차 여부는 검사하지 않음. 스케치 기하는 교차하지 않는다고 가정.
export const extractExtrudableShapes = (
  geometries: Map<string, SerializedGeometry>,
  profileIds?: string[],
  sketchShapes?: SketchShape[],
): THREE.Shape[] => {
  const result = extractExtrudableShapesWithIds(geometries, profileIds, false, sketchShapes);
  return result.map(r => r.shape);
};

export const extractExtrudableShapesWithIds = (
  geometries: Map<string, SerializedGeometry>,
  profileIds?: string[],
  /** true면 hole을 독립 solid로도 추가 (baked face 클릭용). false면 hole만 등록. */
  includeHolesAsSolids = false,
  /** coincident 기반 Shape */
  sketchShapes?: SketchShape[],
): ExtrudableShape[] => {
  const rawShapes: { shape: THREE.Shape; area: number; geomId: string }[] = [];
  const ids = profileIds ?? [...geometries.keys()];

  // sketchShapes에 포함된 기하 ID 수집 (중복 방지)
  const shapeGeomIds = new Set<string>();
  if (sketchShapes) {
    for (const ss of sketchShapes) {
      for (const lid of ss.lineIds) shapeGeomIds.add(lid);
      for (const hole of ss.holes) {
        for (const lid of hole.lineIds) shapeGeomIds.add(lid);
      }
    }
  }

  for (const id of ids) {
    if (shapeGeomIds.has(id)) continue;
    const geom = geometries.get(id);
    if (!geom) continue;
    const shape = geometryToShape(geom);
    if (shape) {
      rawShapes.push({ shape, area: Math.abs(computeShapeArea(shape)), geomId: id });
    }
  }

  // SketchShape → THREE.Shape (coincident 기반)
  if (sketchShapes) {
    const profileIdSet = profileIds ? new Set(profileIds) : null;
    const allSS: SketchShape[] = [];
    for (const ss of sketchShapes) {
      if (profileIdSet && !profileIdSet.has(ss.id)) continue;
      allSS.push(ss);
      for (const hole of ss.holes) allSS.push(hole);
    }
    for (const ss of allSS) {
      const shape = sketchShapeToThreeShape(ss, geometries);
      if (shape) {
        const area = Math.abs(computeShapeArea(shape));
        if (area > 1e-6) rawShapes.push({ shape, area, geomId: ss.id });
      }
    }
  }

  if (rawShapes.length <= 1) {
    return rawShapes.map(s => ({ shape: s.shape, geomId: s.geomId, holeGeomIds: [] }));
  }

  // 면적 내림차순 정렬 (큰 shape 먼저 — 포함 관계 탐색 용이)
  rawShapes.sort((a, b) => b.area - a.area);

  // 각 shape의 포함 깊이 계산 (depth-parity)
  // depth 0 = 최외곽 solid, depth 1 = hole, depth 2 = 섬(solid), ...
  const depth = new Array(rawShapes.length).fill(0);
  // 직계 부모 인덱스 (가장 작은 포함 shape)
  const parent = new Array<number>(rawShapes.length).fill(-1);

  for (let j = 0; j < rawShapes.length; j++) {
    // j보다 면적이 큰 shape(i < j) 중 j를 포함하는 가장 작은 것이 직계 부모
    for (let i = j - 1; i >= 0; i--) {
      if (isShapeContainedIn(rawShapes[j].shape, rawShapes[i].shape)) {
        parent[j] = i;
        depth[j] = depth[i] + 1;
        break; // 면적 내림차순이므로 가장 먼저 찾은 것이 가장 작은 포함 shape
      }
    }
  }

  // depth가 짝수인 shape = solid, 홀수 = hole
  // hole은 직계 부모 solid에 할당
  const results: ExtrudableShape[] = [];
  const solidIndices: number[] = [];

  for (let i = 0; i < rawShapes.length; i++) {
    if (depth[i] % 2 === 0) {
      // solid
      solidIndices.push(i);
      results.push({ shape: rawShapes[i].shape, geomId: rawShapes[i].geomId, holeGeomIds: [] });
    }
  }

  // hole을 직계 부모 solid에 할당 + hole 자체도 독립 solid로 추가 (CATIA 스타일: 2개 프로파일)
  for (let j = 0; j < rawShapes.length; j++) {
    if (depth[j] % 2 !== 1) continue; // hole만 처리
    // 직계 부모 찾기: parent를 따라가며 depth가 짝수인 조상 찾기
    let p = parent[j];
    while (p >= 0 && depth[p] % 2 !== 0) p = parent[p];
    if (p < 0) continue;

    // p가 results에서 몇 번째인지 찾기
    const resultIdx = solidIndices.indexOf(p);
    if (resultIdx < 0) continue;

    const holePath = new THREE.Path(rawShapes[j].shape.getPoints());
    results[resultIdx].shape.holes.push(holePath);
    results[resultIdx].holeGeomIds.push(rawShapes[j].geomId);

    // hole도 독립 face로 추가 (baked sketch face 클릭 선택용)
    if (includeHolesAsSolids) {
      const holeShape = new THREE.Shape(rawShapes[j].shape.getPoints());
      results.push({ shape: holeShape, geomId: rawShapes[j].geomId, holeGeomIds: [] });
    }
  }

  return results;
};

// 기하가 돌출 가능한지 판별
export const isExtrudable = (geom: SerializedGeometry): boolean => {
  return geometryToShape(geom) !== null;
};
