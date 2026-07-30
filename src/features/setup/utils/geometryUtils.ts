// 기하 유틸리티 — 꼭짓점 추출, AABB, 구속 참조 등 공유 로직

import type { SerializedGeometry, VertexHandle } from "../Setup.type";
import type { SketchConstraint } from "../sketch/constraints/SketchConstraint.type";
import { nurbsEvaluate } from "../sketch/curveUtils";

import { normalizeAngle, isAngleBetween } from "./mathUtils";

/**
 * 기하에서 꼭짓점 좌표 추출
 * SketchConstraintSolver / SketchGeometryStore 공통
 */
export function extractVertices(geom: SerializedGeometry): VertexHandle[] {
  switch (geom.type) {
    case "point":
      return [{ geomId: geom.id, vertexIndex: 0, x: geom.x, y: geom.y }];
    case "line":
      return [
        { geomId: geom.id, vertexIndex: 0, x: geom.x1, y: geom.y1 },
        { geomId: geom.id, vertexIndex: 1, x: geom.x2, y: geom.y2 },
      ];
    case "circle":
      return [{ geomId: geom.id, vertexIndex: 0, x: geom.cx, y: geom.cy }];
    case "arc":
      return [
        { geomId: geom.id, vertexIndex: 0, x: geom.cx, y: geom.cy },
        { geomId: geom.id, vertexIndex: 1, x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) },
        { geomId: geom.id, vertexIndex: 2, x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) },
      ];
    case "curve":
      return geom.points.map((p, i) => ({ geomId: geom.id, vertexIndex: i, x: p.x, y: p.y }));
    case "ellipse": {
      // vertex 0: 중심 (cx, cy)
      // vertex 1: focus1 점 — planegcs 타원 프리미티브에 필요
      // focus 거리 = sqrt(a² - b²), a = max(rx, ry), b = min(rx, ry)
      const a = Math.max(geom.rx, geom.ry);
      const b = Math.min(geom.rx, geom.ry);
      const focusDist = Math.sqrt(a * a - b * b);
      // focus1은 장축 방향 (rotation 기준) — rx >= ry면 rotation 방향, 아니면 rotation + 90°
      const focusAngle = geom.rx >= geom.ry ? geom.rotation : geom.rotation + Math.PI / 2;
      const focus1x = geom.cx + focusDist * Math.cos(focusAngle);
      const focus1y = geom.cy + focusDist * Math.sin(focusAngle);
      return [
        { geomId: geom.id, vertexIndex: 0, x: geom.cx, y: geom.cy },
        { geomId: geom.id, vertexIndex: 1, x: focus1x, y: focus1y },
      ];
    }
    case "polygon":
      return geom.vertices.map((p, i) => ({ geomId: geom.id, vertexIndex: i, x: p.x, y: p.y }));
    case "axis":
      // axis 는 무한선 — 가짜 endpoint vertex 없음. snap/hit-test/solver pointRegistry 에서
      // 자동 제외됨.
      return [];
  }
}

/**
 * 기하 꼭짓점 좌표 추출 (vertexIndex 지정)
 * useInputSceneController 등에서 coincident 검증용으로 사용
 */
export function getVertexCoord(geom: SerializedGeometry, vertexIndex: number): { x: number; y: number } | null {
  switch (geom.type) {
    case "point": return { x: geom.x, y: geom.y };
    case "line": return vertexIndex === 0 ? { x: geom.x1, y: geom.y1 } : { x: geom.x2, y: geom.y2 };
    case "circle": return { x: geom.cx, y: geom.cy };
    case "arc":
      if (vertexIndex === 0) return { x: geom.cx, y: geom.cy };
      if (vertexIndex === 1) return { x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) };
      return { x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) };
    case "curve": return geom.points[vertexIndex] ?? null;
    case "ellipse": {
      if (vertexIndex === 0) return { x: geom.cx, y: geom.cy };
      if (vertexIndex === 1) {
        // focus1 점 좌표
        const eA = Math.max(geom.rx, geom.ry);
        const eB = Math.min(geom.rx, geom.ry);
        const eFocusDist = Math.sqrt(eA * eA - eB * eB);
        const eFocusAngle = geom.rx >= geom.ry ? geom.rotation : geom.rotation + Math.PI / 2;
        return { x: geom.cx + eFocusDist * Math.cos(eFocusAngle), y: geom.cy + eFocusDist * Math.sin(eFocusAngle) };
      }
      return { x: geom.cx, y: geom.cy };
    }
    case "polygon": return geom.vertices[vertexIndex] ?? null;
    case "axis": return null;
  }
}

/**
 * 기하의 AABB (Axis-Aligned Bounding Box) 계산
 * curve는 NURBS 평가 점 기반 (제어점이 아닌 실제 곡선 경로)
 */
export function computeAABB(geom: SerializedGeometry): { minX: number; minY: number; maxX: number; maxY: number } | null {
  switch (geom.type) {
    case "point":
      return { minX: geom.x, minY: geom.y, maxX: geom.x, maxY: geom.y };
    case "line":
      return {
        minX: Math.min(geom.x1, geom.x2), minY: Math.min(geom.y1, geom.y2),
        maxX: Math.max(geom.x1, geom.x2), maxY: Math.max(geom.y1, geom.y2),
      };
    case "circle":
      return {
        minX: geom.cx - geom.r, minY: geom.cy - geom.r,
        maxX: geom.cx + geom.r, maxY: geom.cy + geom.r,
      };
    case "arc": {
      // 호의 바운딩 박스: 시작/끝점 + 축 교차점
      const pts = [
        { x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) },
        { x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) },
      ];
      // 축 교차 체크 (0, π/2, π, 3π/2)
      const axes = [0, Math.PI / 2, Math.PI, Math.PI * 3 / 2];
      for (const a of axes) {
        if (isAngleBetween(a, normalizeAngle(geom.startAngle), normalizeAngle(geom.endAngle))) {
          pts.push({ x: geom.cx + geom.r * Math.cos(a), y: geom.cy + geom.r * Math.sin(a) });
        }
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    }
    case "curve": {
      // FIX A3: NURBS 평가 점 기반 AABB (제어점이 아닌 실제 곡선 경로)
      const evaluated = nurbsEvaluate(geom.points, geom.degree, geom.knots, geom.weights, geom.points.length * 8);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of evaluated) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    }
    case "ellipse": {
      // 회전된 타원의 AABB: 각 축 방향 극값 계산
      const cosR = Math.cos(geom.rotation);
      const sinR = Math.sin(geom.rotation);
      const halfW = Math.hypot(geom.rx * cosR, geom.ry * sinR);
      const halfH = Math.hypot(geom.rx * sinR, geom.ry * cosR);
      return {
        minX: geom.cx - halfW, minY: geom.cy - halfH,
        maxX: geom.cx + halfW, maxY: geom.cy + halfH,
      };
    }
    case "polygon": {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of geom.vertices) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    }
    case "axis":
      // 무한선이라 AABB 의미 없음. caller (SpatialGrid 등) 가 null 처리.
      return null;
  }
}

/**
 * 구속조건이 참조하는 모든 기하 ID 추출
 * SketchGeometryStore / SketchConstraintStore 공통
 */
export function getConstraintGeomIds(c: SketchConstraint): string[] {
  switch (c.type) {
    case "coincident":
      return [c.pointA.geomId, c.pointB.geomId];
    case "horizontal":
    case "vertical":
      return [c.line.geomId];
    case "horizontal_pp":
    case "vertical_pp":
      return [c.pointA.geomId, c.pointB.geomId];
    case "fix":
      return [c.point.geomId];
    case "distance":
    case "horizontal_distance":
    case "vertical_distance":
      return [c.pointA.geomId, c.pointB.geomId];
    case "equal":
    case "parallel":
    case "perpendicular":
    case "colinear":
      return [c.lineA.geomId, c.lineB.geomId];
    case "tangent":
      return [c.entityA.geomId, c.entityB.geomId];
    case "point_on_line":
    case "midpoint":
      return [c.point.geomId, c.line.geomId];
    case "concentric":
      return [c.circleA.geomId, c.circleB.geomId];
    case "point_on_circle":
      return [c.point.geomId, c.circle.geomId];
    case "radius":
    case "diameter":
      return [c.circle.geomId];
    case "equal_radius":
      return [c.circleA.geomId, c.circleB.geomId];
    case "line_length":
      return [c.line.geomId];
    case "line_angle":
      return [c.line.geomId];
    case "angle":
      return [c.lineA.geomId, c.lineB.geomId];
    case "point_line_distance":
      return [c.point.geomId, c.line.geomId];
    case "line_line_distance":
      return [c.lineA.geomId, c.lineB.geomId];
    case "point_circle_distance":
      return [c.point.geomId, c.circle.geomId];
    case "line_circle_distance":
      return [c.line.geomId, c.circle.geomId];
    case "circle_circle_distance":
      return [c.circleA.geomId, c.circleB.geomId];
    case "arc_length":
      return [c.arc.geomId];
    case "ellipse_major_radius":
    case "ellipse_minor_radius":
      return [c.ellipse.geomId];
    case "curve_length":
      return [c.curve.geomId];
    case "symmetric":
      return [c.pointA.geomId, c.pointB.geomId, c.axis.geomId];
    case "symmetric_point":
      return [c.pointA.geomId, c.pointB.geomId, c.center.geomId];
    case "equidistant":
      return [c.pointA.geomId, c.pointB.geomId, c.center.geomId];
    case "fix_together":
      return c.elements.map((e) => e.geomId);
    default: {
      const _exhaustive: never = c;
      return _exhaustive;
    }
  }
}

/**
 * Constraint 의 reference 를 "point" 와 "geom" 으로 분리.
 * - pointRefs: pointA/pointB/point/center — sketch 의 point 의미. vertex source (line endpoint
 *   같은) 일 수 있어 parent geometry 까지 highlight 하면 misleading.
 * - geomRefs: lineA/lineB/line/circle/axis/entityA/entityB/arc/ellipse/curve — geometry 그 자체.
 *
 * computeDependencyHighlight 가 이 분리를 사용해 point ref 의 경우 type === "point" 인 geometry
 * 만 highlight (line endpoint 의 parent line 은 제외).
 */
export function getConstraintRefs(c: SketchConstraint): {
  pointRefs: { geomId: string; vertexIndex: number }[];
  geomRefs: string[];
} {
  switch (c.type) {
    case "coincident":
    case "horizontal_pp":
    case "vertical_pp":
    case "distance":
    case "horizontal_distance":
    case "vertical_distance":
      return { pointRefs: [c.pointA, c.pointB], geomRefs: [] };
    case "horizontal":
    case "vertical":
    case "line_length":
    case "line_angle":
      return { pointRefs: [], geomRefs: [c.line.geomId] };
    case "fix":
      return { pointRefs: [c.point], geomRefs: [] };
    case "equal":
    case "parallel":
    case "perpendicular":
    case "colinear":
    case "angle":
    case "line_line_distance":
      return { pointRefs: [], geomRefs: [c.lineA.geomId, c.lineB.geomId] };
    case "tangent":
      return { pointRefs: [], geomRefs: [c.entityA.geomId, c.entityB.geomId] };
    case "point_on_line":
    case "midpoint":
    case "point_line_distance":
      return { pointRefs: [c.point], geomRefs: [c.line.geomId] };
    case "concentric":
    case "equal_radius":
    case "circle_circle_distance":
      return { pointRefs: [], geomRefs: [c.circleA.geomId, c.circleB.geomId] };
    case "point_on_circle":
    case "point_circle_distance":
      return { pointRefs: [c.point], geomRefs: [c.circle.geomId] };
    case "line_circle_distance":
      return { pointRefs: [], geomRefs: [c.line.geomId, c.circle.geomId] };
    case "radius":
    case "diameter":
      return { pointRefs: [], geomRefs: [c.circle.geomId] };
    case "arc_length":
      return { pointRefs: [], geomRefs: [c.arc.geomId] };
    case "ellipse_major_radius":
    case "ellipse_minor_radius":
      return { pointRefs: [], geomRefs: [c.ellipse.geomId] };
    case "curve_length":
      return { pointRefs: [], geomRefs: [c.curve.geomId] };
    case "symmetric":
      return { pointRefs: [c.pointA, c.pointB], geomRefs: [c.axis.geomId] };
    case "symmetric_point":
      return { pointRefs: [c.pointA, c.pointB, c.center], geomRefs: [] };
    case "equidistant":
      return { pointRefs: [c.pointA, c.pointB, c.center], geomRefs: [] };
    case "fix_together":
      return { pointRefs: [], geomRefs: c.elements.map((e) => e.geomId) };
    default: {
      const _exhaustive: never = c;
      return _exhaustive;
    }
  }
}
