// Fillet/Chamfer/Corner 도구의 공통 유틸리티
// 2선 교차점 탐색, 꼭짓점 매칭, 방향 결정 등 편집 도구에서 공유하는 로직

import type { SerializedGeometry, VertexHandle } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";
import { normalizeVector } from "../../utils/mathUtils";

import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import { lineLineIntersectionUnbounded } from "../GeometryIntersection";
import type { SketchGeometryStore } from "../SketchGeometryStore";

// 꼭짓점 매칭 허용 오차
const VERTEX_MATCH_EPSILON = 1e-4;

// 참조/건설 기하인지 확인
export function isRefOrConstruction(geom: SerializedGeometry): boolean {
  return ("isReference" in geom && !!geom.isReference) || ("isConstruction" in geom && !!geom.isConstruction);
}

// 편집 가능 line 목록 (비참조/비건설)
export function getEditableLines(store: SketchGeometryStore): (SerializedGeometry & { type: "line" })[] {
  const lines: (SerializedGeometry & { type: "line" })[] = [];
  for (const geom of store.geometries.values()) {
    if (geom.type !== "line" || isRefOrConstruction(geom)) continue;
    lines.push(geom);
  }
  return lines;
}

// vertex 좌표에서 endpoint가 일치하는 비참조/비건설 line 2개 찾기
export function findLinesAtVertex(
  store: SketchGeometryStore,
  vertex: VertexHandle,
): [SerializedGeometry & { type: "line" }, SerializedGeometry & { type: "line" }] | null {
  const vx = vertex.x, vy = vertex.y;
  const matches: (SerializedGeometry & { type: "line" })[] = [];
  for (const geom of store.geometries.values()) {
    if (geom.type !== "line" || isRefOrConstruction(geom)) continue;
    const d1 = Math.hypot(geom.x1 - vx, geom.y1 - vy);
    const d2 = Math.hypot(geom.x2 - vx, geom.y2 - vy);
    if (d1 < VERTEX_MATCH_EPSILON || d2 < VERTEX_MATCH_EPSILON) {
      matches.push(geom);
      if (matches.length >= 2) break;
    }
  }
  return matches.length >= 2 ? [matches[0], matches[1]] : null;
}

// vertex가 x1 쪽 → farEnd = x2 → keepDir = 1 (x1→x2 방향 보존)
// vertex가 x2 쪽 → farEnd = x1 → keepDir = -1 (x2→x1 방향 보존)
export function getKeepDirFromVertex(
  line: SerializedGeometry & { type: "line" },
  vertex: VertexHandle,
): 1 | -1 {
  const d1 = Math.hypot(line.x1 - vertex.x, line.y1 - vertex.y);
  const d2 = Math.hypot(line.x2 - vertex.x, line.y2 - vertex.y);
  return d1 < d2 ? 1 : -1;
}

// 교차점 근처 클릭 폴백용: t 기반 방향
export function getKeepDirFromT(t: number): 1 | -1 {
  return t <= 0.5 ? 1 : -1;
}

// 커서 사분면 기반 방향 결정 (4조합 이등분선과 커서 벡터의 dot product)
export function determineCornerQuadrant(
  line1: SerializedGeometry & { type: "line" },
  line2: SerializedGeometry & { type: "line" },
  intersection: { x: number; y: number },
  cursor: { x: number; y: number },
): { keepDir1: 1 | -1; keepDir2: 1 | -1 } {
  const P = intersection;
  const u1 = normalizeVector(line1.x2 - line1.x1, line1.y2 - line1.y1);
  const u2 = normalizeVector(line2.x2 - line2.x1, line2.y2 - line2.y1);
  const cx = cursor.x - P.x, cy = cursor.y - P.y;

  let bestDot = -Infinity;
  let bestDir1: 1 | -1 = 1;
  let bestDir2: 1 | -1 = 1;

  for (const s1 of [1, -1] as const) {
    for (const s2 of [1, -1] as const) {
      const b = normalizeVector(s1 * u1.x + s2 * u2.x, s1 * u1.y + s2 * u2.y);
      if (b.x === 0 && b.y === 0) continue;
      const dot = b.x * cx + b.y * cy;
      if (dot > bestDot) {
        bestDot = dot;
        bestDir1 = s1;
        bestDir2 = s2;
      }
    }
  }

  return { keepDir1: bestDir1, keepDir2: bestDir2 };
}

// 클릭 위치 근처에서 두 선의 교차점 찾기
export function findCornerNearPoint(
  store: SketchGeometryStore,
  worldPos: { x: number; y: number },
  searchRadius: number,
): { line1: SerializedGeometry & { type: "line" }; line2: SerializedGeometry & { type: "line" }; intersection: { x: number; y: number; t1: number; t2: number } } | null {
  const lines = getEditableLines(store);
  let bestDist = Infinity;
  let bestResult: ReturnType<typeof findCornerNearPoint> = null;

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const hit = lineLineIntersectionUnbounded(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2);
      if (!hit) continue;
      const dist = Math.hypot(hit.x - worldPos.x, hit.y - worldPos.y);
      if (dist < searchRadius && dist < bestDist) {
        bestDist = dist;
        bestResult = { line1: a, line2: b, intersection: hit };
      }
    }
  }
  return bestResult;
}

/**
 * 복제본을 만든 변환. 원본의 방향·크기 구속을 그대로 옮기면 솔버가 복제본을 원본 자세·크기로
 * 되돌리므로, cloneInternalConstraints 가 이 변환에 맞춰 구속을 바꾼다.
 */
export type CloneTransform =
  | { kind: "translate" }
  | { kind: "rotate"; angle: number } // 회전각 (라디안)
  | { kind: "mirror"; axisAngle: number } // 대칭축 방향각 (라디안)
  | { kind: "scale"; factor: number };

// 변환 뒤 방향이 축과 나란한지 판정하는 허용 오차 (단위 벡터 성분)
const AXIS_ALIGN_EPSILON = 1e-6;

/**
 * 선택된 기하 ID 집합 내부의 구속을 복제하여 새 기하 ID에 매핑
 * 외부 기하와의 구속은 복제하지 않음 (내부 구속만 복제)
 * @param store - SketchGeometryStore
 * @param oldIds - 원본 기하 ID 배열
 * @param newIds - 복제본 기하 ID 배열 (oldIds와 1:1 대응)
 * @param transform - 복제본을 만든 변환 (방향·치수 구속을 결과에 맞추는 데 사용)
 * @returns 복제된 SketchConstraint 배열
 */
export function cloneInternalConstraints(
  store: SketchGeometryStore,
  oldIds: string[],
  newIds: string[],
  transform: CloneTransform,
): SketchConstraint[] {
  if (!store.constraintStore || oldIds.length === 0) return [];

  // oldId → newId 매핑 테이블
  const idMap = new Map<string, string>();
  for (let i = 0; i < oldIds.length; i++) {
    idMap.set(oldIds[i], newIds[i]);
  }

  const oldIdSet = new Set(oldIds);
  const result: SketchConstraint[] = [];

  // 고유 ID 생성
  const generateCloneId = (): string =>
    generateConstraintId("auto-clone");

  // 구속이 참조하는 모든 geomId가 oldIdSet 내부인지 확인
  const allRefsInternal = (geomIds: string[]): boolean =>
    geomIds.every((id) => oldIdSet.has(id));

  // ConstraintPointRef 매핑 (geomId 변경, vertexIndex 는 대칭된 호만 교환)
  // 대칭은 호를 CCW 로 유지하려고 start/end 를 맞바꾸므로(Mirror/SymmetryMove), 호의 vertex 1(start)↔2(end)
  // 도 바꿔야 복제 구속이 원본과 같은 끝점에 걸린다. vertex 0(중심)은 그대로.
  const mapPointRef = (ref: { geomId: string; vertexIndex: number }) => {
    let vertexIndex = ref.vertexIndex;
    if (transform.kind === "mirror" && store.geometries.get(ref.geomId)?.type === "arc" && vertexIndex !== 0) {
      vertexIndex = vertexIndex === 1 ? 2 : 1;
    }
    return { geomId: idMap.get(ref.geomId)!, vertexIndex };
  };

  // ConstraintGeomRef 매핑
  const mapGeomRef = (ref: { geomId: string }) => ({
    geomId: idMap.get(ref.geomId)!,
  });

  // 변환의 방향 행렬: (x, y) → (m00·x + m01·y, m10·x + m11·y). 평행이동·스케일은 방향을 바꾸지 않음.
  // cos/sin 은 구속마다가 아니라 여기서 한 번만 계산한다.
  const [m00, m01, m10, m11] = ((): [number, number, number, number] => {
    if (transform.kind === "rotate") {
      const cos = Math.cos(transform.angle), sin = Math.sin(transform.angle);
      return [cos, -sin, sin, cos];
    }
    if (transform.kind === "mirror") {
      const cos = Math.cos(2 * transform.axisAngle), sin = Math.sin(2 * transform.axisAngle);
      return [cos, sin, sin, -cos];
    }
    return [1, 0, 0, 1];
  })();
  const mapDirection = (x: number, y: number) => ({ x: m00 * x + m01 * y, y: m10 * x + m11 * y });

  // horizontal/vertical 의 복제 대상: 변환 뒤에도 축과 나란하면 그 방향 구속 (90° 회전이면 H↔V), 아니면 null
  const axisConstraintType = (d: { x: number; y: number }): "horizontal" | "vertical" | null => {
    if (Math.abs(d.y) < AXIS_ALIGN_EPSILON) return "horizontal";
    if (Math.abs(d.x) < AXIS_ALIGN_EPSILON) return "vertical";
    return null;
  };
  const clonedAxisType = {
    horizontal: axisConstraintType(mapDirection(1, 0)),
    vertical: axisConstraintType(mapDirection(0, 1)),
  };

  // 길이 치수는 스케일 배율만큼 바꾼다 (회전·대칭·평행이동은 길이를 지킴, 각도는 배율과 무관)
  const lengthScale = transform.kind === "scale" ? transform.factor : 1;

  for (const c of store.constraintStore.constraints.values()) {
    let cloned: SketchConstraint | null = null;

    switch (c.type) {
      case "coincident":
        if (allRefsInternal([c.pointA.geomId, c.pointB.geomId])) {
          cloned = { type: "coincident", id: generateCloneId(), pointA: mapPointRef(c.pointA), pointB: mapPointRef(c.pointB) };
        }
        break;
      case "horizontal":
      case "vertical":
        if (allRefsInternal([c.line.geomId])) {
          const type = clonedAxisType[c.type];
          if (type) {
            cloned = { type, id: generateCloneId(), line: mapGeomRef(c.line) };
          } else {
            // 비스듬해진 복제본에 H/V 를 그대로 걸면 솔버가 축에 다시 세우며 찌그러뜨리므로,
            // 변환 뒤 지금 방향의 절대 각도(line_angle, 도)로 바꿔 원본과 같은 자유도를 지킨다
            const line = store.geometries.get(c.line.geomId);
            if (line?.type === "line") {
              const d = mapDirection(line.x2 - line.x1, line.y2 - line.y1);
              cloned = { type: "line_angle", id: generateCloneId(), line: mapGeomRef(c.line), value: (Math.atan2(d.y, d.x) * 180) / Math.PI };
            }
          }
        }
        break;
      // fix 구속은 복제하지 않음 (좌표 의존적이므로)
      case "fix":
        break;
      case "distance":
        if (allRefsInternal([c.pointA.geomId, c.pointB.geomId])) {
          cloned = { type: "distance", id: generateCloneId(), pointA: mapPointRef(c.pointA), pointB: mapPointRef(c.pointB), value: c.value * lengthScale, ...(c.isReference ? { isReference: true } : {}) };
        }
        break;
      case "equal":
        if (allRefsInternal([c.lineA.geomId, c.lineB.geomId])) {
          cloned = { type: "equal", id: generateCloneId(), lineA: mapGeomRef(c.lineA), lineB: mapGeomRef(c.lineB) };
        }
        break;
      case "parallel":
        if (allRefsInternal([c.lineA.geomId, c.lineB.geomId])) {
          cloned = { type: "parallel", id: generateCloneId(), lineA: mapGeomRef(c.lineA), lineB: mapGeomRef(c.lineB) };
        }
        break;
      case "perpendicular":
        if (allRefsInternal([c.lineA.geomId, c.lineB.geomId])) {
          cloned = { type: "perpendicular", id: generateCloneId(), lineA: mapGeomRef(c.lineA), lineB: mapGeomRef(c.lineB) };
        }
        break;
      case "colinear":
        if (allRefsInternal([c.lineA.geomId, c.lineB.geomId])) {
          cloned = { type: "colinear", id: generateCloneId(), lineA: mapGeomRef(c.lineA), lineB: mapGeomRef(c.lineB) };
        }
        break;
      case "tangent":
        if (allRefsInternal([c.entityA.geomId, c.entityB.geomId])) {
          cloned = { type: "tangent", id: generateCloneId(), entityA: mapGeomRef(c.entityA), entityB: mapGeomRef(c.entityB) };
        }
        break;
      case "concentric":
        if (allRefsInternal([c.circleA.geomId, c.circleB.geomId])) {
          cloned = { type: "concentric", id: generateCloneId(), circleA: mapGeomRef(c.circleA), circleB: mapGeomRef(c.circleB) };
        }
        break;
      case "equal_radius":
        if (allRefsInternal([c.circleA.geomId, c.circleB.geomId])) {
          cloned = { type: "equal_radius", id: generateCloneId(), circleA: mapGeomRef(c.circleA), circleB: mapGeomRef(c.circleB) };
        }
        break;
      case "midpoint":
        if (allRefsInternal([c.point.geomId, c.line.geomId])) {
          cloned = { type: "midpoint", id: generateCloneId(), point: mapPointRef(c.point), line: mapGeomRef(c.line) };
        }
        break;
      case "point_on_line":
        if (allRefsInternal([c.point.geomId, c.line.geomId])) {
          cloned = { type: "point_on_line", id: generateCloneId(), point: mapPointRef(c.point), line: mapGeomRef(c.line) };
        }
        break;
      case "point_on_circle":
        if (allRefsInternal([c.point.geomId, c.circle.geomId])) {
          cloned = { type: "point_on_circle", id: generateCloneId(), point: mapPointRef(c.point), circle: mapGeomRef(c.circle) };
        }
        break;
      case "radius":
        if (allRefsInternal([c.circle.geomId])) {
          cloned = { type: "radius", id: generateCloneId(), circle: mapGeomRef(c.circle), value: c.value * lengthScale, ...(c.isReference ? { isReference: true } : {}) };
        }
        break;
      case "line_length":
        if (allRefsInternal([c.line.geomId])) {
          cloned = { type: "line_length", id: generateCloneId(), line: mapGeomRef(c.line), value: c.value * lengthScale, ...(c.isReference ? { isReference: true } : {}) };
        }
        break;
      case "angle":
        if (allRefsInternal([c.lineA.geomId, c.lineB.geomId])) {
          cloned = { type: "angle", id: generateCloneId(), lineA: mapGeomRef(c.lineA), lineB: mapGeomRef(c.lineB), value: c.value, ...(c.isReference ? { isReference: true } : {}), ...(c.isAcute === false ? { isAcute: false } : {}) };
        }
        break;
      case "point_line_distance":
        if (allRefsInternal([c.point.geomId, c.line.geomId])) {
          cloned = { type: "point_line_distance", id: generateCloneId(), point: mapPointRef(c.point), line: mapGeomRef(c.line), value: c.value * lengthScale, ...(c.isReference ? { isReference: true } : {}) };
        }
        break;
      case "symmetric":
        if (allRefsInternal([c.pointA.geomId, c.pointB.geomId, c.axis.geomId])) {
          cloned = { type: "symmetric", id: generateCloneId(), pointA: mapPointRef(c.pointA), pointB: mapPointRef(c.pointB), axis: mapGeomRef(c.axis) };
        }
        break;
    }

    if (cloned) {
      result.push(cloned);
    }
  }

  return result;
}
