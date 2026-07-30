// CATIA V5식 Auto Constraint: 선택된 기하 분석 → 적용 가능한 모든 구속조건 일괄 탐지
// 우선순위: Horizontal/Vertical → Coincident → Parallel → Perpendicular → Equal → Tangent → Concentric

import type { SerializedGeometry } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { isReferenceId } from "../SketchGeometryStore";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchConstraint } from "./SketchConstraint.type";

// --- 허용 오차 상수 ---
const POSITION_TOLERANCE = 0.5;    // coincident/concentric 위치 허용 오차 (world units)
const ANGLE_TOLERANCE_DEG = 2;     // horizontal/vertical/parallel/perpendicular 각도 허용 오차 (도)
const LENGTH_TOLERANCE = 0.5;      // equal length 허용 오차 (world units)

const ANGLE_TOLERANCE_RAD = ANGLE_TOLERANCE_DEG * Math.PI / 180;
const TANGENT_COS_THRESHOLD = Math.sin(ANGLE_TOLERANCE_RAD * 2);

// 고유 ID 생성
function genId(): string {
  return generateConstraintId();
}

// 선분 방향 벡터 (정규화되지 않은)
function lineDir(g: SerializedGeometry & { type: "line" }): { dx: number; dy: number; len: number } {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  return { dx, dy, len: Math.hypot(dx, dy) };
}

// 두 벡터 사이 각도 (0 ~ PI 범위)
function angleBetween(dx1: number, dy1: number, dx2: number, dy2: number): number {
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);
  if (len1 < 1e-9 || len2 < 1e-9) return Infinity;
  const cos = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (len1 * len2)));
  return Math.acos(Math.abs(cos)); // abs로 반대 방향도 동일하게 취급
}

// 기존 구속조건과 중복되는지 검사
function isDuplicate(
  existing: Map<string, SketchConstraint>,
  candidate: SketchConstraint,
): boolean {
  for (const c of existing.values()) {
    if (c.type !== candidate.type) continue;
    switch (c.type) {
      case "horizontal":
      case "vertical": {
        const cc = candidate as typeof c;
        if (c.line.geomId === cc.line.geomId) return true;
        break;
      }
      case "coincident": {
        const cc = candidate as typeof c;
        // A-B 또는 B-A 순서 모두 검사
        if (
          (c.pointA.geomId === cc.pointA.geomId && c.pointA.vertexIndex === cc.pointA.vertexIndex &&
           c.pointB.geomId === cc.pointB.geomId && c.pointB.vertexIndex === cc.pointB.vertexIndex) ||
          (c.pointA.geomId === cc.pointB.geomId && c.pointA.vertexIndex === cc.pointB.vertexIndex &&
           c.pointB.geomId === cc.pointA.geomId && c.pointB.vertexIndex === cc.pointA.vertexIndex)
        ) return true;
        break;
      }
      case "parallel":
      case "perpendicular":
      case "equal":
      case "colinear": {
        const cc = candidate as typeof c;
        if (
          (c.lineA.geomId === cc.lineA.geomId && c.lineB.geomId === cc.lineB.geomId) ||
          (c.lineA.geomId === cc.lineB.geomId && c.lineB.geomId === cc.lineA.geomId)
        ) return true;
        break;
      }
      case "tangent": {
        const cc = candidate as typeof c;
        if (
          (c.entityA.geomId === cc.entityA.geomId && c.entityB.geomId === cc.entityB.geomId) ||
          (c.entityA.geomId === cc.entityB.geomId && c.entityB.geomId === cc.entityA.geomId)
        ) return true;
        break;
      }
      case "concentric": {
        const cc = candidate as typeof c;
        if (
          (c.circleA.geomId === cc.circleA.geomId && c.circleB.geomId === cc.circleB.geomId) ||
          (c.circleA.geomId === cc.circleB.geomId && c.circleB.geomId === cc.circleA.geomId)
        ) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * 선택된 기하에 대해 적용 가능한 모든 구속조건을 탐지
 * @param store 기하 저장소
 * @param selectedIds 선택된 기하 ID 목록 (비어있으면 전체 기하 대상)
 * @returns 탐지된 구속조건 목록 (중복 제외, 우선순위 순)
 */
export function detectAutoConstraints(
  store: SketchGeometryStore,
  selectedIds: string[],
): SketchConstraint[] {
  const existing = store.constraintStore?.constraints ?? new Map<string, SketchConstraint>();
  const results: SketchConstraint[] = [];

  // 대상 기하 수집 (참조 기하 제외)
  const targetIds = selectedIds.length > 0
    ? selectedIds.filter((id) => !isReferenceId(id))
    : [...store.geometries.keys()].filter((id) => !isReferenceId(id));

  const targetGeoms = targetIds
    .map((id) => store.geometries.get(id))
    .filter(Boolean) as SerializedGeometry[];

  const lines = targetGeoms.filter((g): g is SerializedGeometry & { type: "line" } => g.type === "line");
  const circles = targetGeoms.filter((g): g is SerializedGeometry & { type: "circle" | "arc" } => g.type === "circle" || g.type === "arc");

  // 이미 추가 예정인 구속과의 중복 방지 (결과 맵)
  const resultsMap = new Map<string, SketchConstraint>();
  const addIfNotDuplicate = (c: SketchConstraint): void => {
    if (!isDuplicate(existing, c) && !isDuplicate(resultsMap, c)) {
      resultsMap.set(c.id, c);
      results.push(c);
    }
  };

  // --- 1. Horizontal / Vertical (단일 선) ---
  for (const line of lines) {
    if ("isConstruction" in line && line.isConstruction) continue;
    const { dx, dy, len } = lineDir(line);
    if (len < 1e-9) continue;

    const absAngle = Math.atan2(Math.abs(dy), Math.abs(dx));

    // Horizontal: |dy| / |dx| < tan(tolerance)
    if (absAngle < ANGLE_TOLERANCE_RAD) {
      addIfNotDuplicate({
        type: "horizontal", id: genId(),
        line: { geomId: line.id },
      });
    }
    // Vertical: |dx| / |dy| < tan(tolerance)
    else if (Math.abs(absAngle - Math.PI / 2) < ANGLE_TOLERANCE_RAD) {
      addIfNotDuplicate({
        type: "vertical", id: genId(),
        line: { geomId: line.id },
      });
    }
  }

  // --- 2. Coincident (두 꼭짓점이 동일 위치) ---
  // 모든 대상 기하의 꼭짓점 수집
  type VertexInfo = { geomId: string; vertexIndex: number; x: number; y: number };
  const allVertices: VertexInfo[] = [];
  for (const geom of targetGeoms) {
    const handles = store.getVertexHandles(geom.id);
    for (const h of handles) {
      // 원/원호의 중심점(vertexIndex 0)은 coincident 대상에서 제외
      if ((geom.type === "circle" || geom.type === "arc") && h.vertexIndex === 0) continue;
      allVertices.push(h);
    }
  }

  for (let i = 0; i < allVertices.length; i++) {
    for (let j = i + 1; j < allVertices.length; j++) {
      const a = allVertices[i];
      const b = allVertices[j];
      // 같은 기하의 꼭짓점끼리는 coincident 불허
      if (a.geomId === b.geomId) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist < POSITION_TOLERANCE) {
        addIfNotDuplicate({
          type: "coincident", id: genId(),
          pointA: { geomId: a.geomId, vertexIndex: a.vertexIndex },
          pointB: { geomId: b.geomId, vertexIndex: b.vertexIndex },
        });
      }
    }
  }

  // --- 3. Parallel (두 선의 방향이 유사) ---
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const dA = lineDir(lines[i]);
      const dB = lineDir(lines[j]);
      if (dA.len < 1e-9 || dB.len < 1e-9) continue;
      const angle = angleBetween(dA.dx, dA.dy, dB.dx, dB.dy);
      if (angle < ANGLE_TOLERANCE_RAD) {
        addIfNotDuplicate({
          type: "parallel", id: genId(),
          lineA: { geomId: lines[i].id },
          lineB: { geomId: lines[j].id },
        });
      }
    }
  }

  // --- 4. Perpendicular (두 선이 직교) ---
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const dA = lineDir(lines[i]);
      const dB = lineDir(lines[j]);
      if (dA.len < 1e-9 || dB.len < 1e-9) continue;
      const angle = angleBetween(dA.dx, dA.dy, dB.dx, dB.dy);
      if (Math.abs(angle - Math.PI / 2) < ANGLE_TOLERANCE_RAD) {
        addIfNotDuplicate({
          type: "perpendicular", id: genId(),
          lineA: { geomId: lines[i].id },
          lineB: { geomId: lines[j].id },
        });
      }
    }
  }

  // --- 5. Equal (두 선의 길이가 유사) ---
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const lenA = lineDir(lines[i]).len;
      const lenB = lineDir(lines[j]).len;
      if (lenA < 1e-9 || lenB < 1e-9) continue;
      if (Math.abs(lenA - lenB) < LENGTH_TOLERANCE) {
        addIfNotDuplicate({
          type: "equal", id: genId(),
          lineA: { geomId: lines[i].id },
          lineB: { geomId: lines[j].id },
        });
      }
    }
  }

  // --- 6. Tangent (선 끝점이 원/호 위에 있고 반지름에 수직) ---
  for (const line of lines) {
    for (const circle of circles) {
      // 선의 양 끝점 검사
      const endpoints = [
        { x: line.x1, y: line.y1 },
        { x: line.x2, y: line.y2 },
      ];
      const cx = circle.cx;
      const cy = circle.cy;
      const r = circle.r;

      for (const ep of endpoints) {
        const distToCenter = Math.hypot(ep.x - cx, ep.y - cy);
        // 끝점이 원주 위에 있는지 검사
        if (Math.abs(distToCenter - r) > POSITION_TOLERANCE) continue;

        // 반지름 벡터 (중심 → 끝점)
        const rx = ep.x - cx;
        const ry = ep.y - cy;
        // 선 방향 벡터
        const ldx = line.x2 - line.x1;
        const ldy = line.y2 - line.y1;

        // 수직 검사: 내적이 0에 가까운지
        const dot = rx * ldx + ry * ldy;
        const lenR = Math.hypot(rx, ry);
        const lenL = Math.hypot(ldx, ldy);
        if (lenR < 1e-9 || lenL < 1e-9) continue;

        const cosAngle = Math.abs(dot) / (lenR * lenL);
        if (cosAngle < TANGENT_COS_THRESHOLD) { // 약 4° 허용
          addIfNotDuplicate({
            type: "tangent", id: genId(),
            entityA: { geomId: line.id },
            entityB: { geomId: circle.id },
          });
          break; // 한 선-원 쌍에 대해 1개만
        }
      }
    }
  }

  // 원/호 쌍 간 접선 검사
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const cA = circles[i];
      const cB = circles[j];
      const dist = Math.hypot(cA.cx - cB.cx, cA.cy - cB.cy);
      // 외접: d ≈ rA + rB, 내접: d ≈ |rA - rB|
      if (Math.abs(dist - (cA.r + cB.r)) < POSITION_TOLERANCE ||
          Math.abs(dist - Math.abs(cA.r - cB.r)) < POSITION_TOLERANCE) {
        addIfNotDuplicate({
          type: "tangent", id: genId(),
          entityA: { geomId: cA.id },
          entityB: { geomId: cB.id },
        });
      }
    }
  }

  // --- 7. Concentric (두 원/호의 중심이 동일) ---
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const cA = circles[i];
      const cB = circles[j];
      const dist = Math.hypot(cA.cx - cB.cx, cA.cy - cB.cy);
      if (dist < POSITION_TOLERANCE) {
        addIfNotDuplicate({
          type: "concentric", id: genId(),
          circleA: { geomId: cA.id },
          circleB: { geomId: cB.id },
        });
      }
    }
  }

  return results;
}
