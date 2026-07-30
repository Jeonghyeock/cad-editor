// 통합 선택 상태 → 적용 가능 구속 판별 + 구속 생성 헬퍼
// CATIA식 단일 selection 배열에서 geometry/vertex를 동시 추출하여 판별

import type { SerializedGeometry, VertexHandle } from "../../Setup.type";
import { getVertexCoord } from "../../utils/geometryUtils";
import { generateConstraintId } from "../../utils/idGenerator";
import { pointToLineDistance } from "../../utils/mathUtils";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { ConstraintPointRef, SketchConstraint } from "./SketchConstraint.type";


export type ConstraintApplicability = {
  coincident: boolean;
  horizontal: boolean;
  vertical: boolean;
  fix: boolean;
  equal: boolean;
  parallel: boolean;
  perpendicular: boolean;
  tangent: boolean;
  midpoint: boolean;
  concentric: boolean;
  colinear: boolean;
  point_on_circle: boolean;
  equal_radius: boolean;
  symmetric: boolean;
  equidistant: boolean;
  fix_together: boolean;
};

/** Dimension 구속 통합 자동 감지 결과 타입 */
export type DimensionConstraintType = "distance" | "horizontal_distance" | "vertical_distance" | "line_length" | "line_angle" | "angle" | "radius" | "diameter" | "point_line_distance" | "line_line_distance" | "point_circle_distance" | "line_circle_distance" | "circle_circle_distance" | "arc_length" | "ellipse_major_radius" | "ellipse_minor_radius" | "curve_length";

/**
 * solver 가 enforce 못하는 dim — 표시만 갱신 (driven). 사용자가 isReference=false 로 set 해도
 * 사실상 무시. createDimensionConstraint 가 자동으로 isReference=true 강제.
 *   - ellipse_major_radius: planegcs ellipse 가 (center, focus, radmin) 표현 — radmaj derived
 *   - curve_length: planegcs 에 BSpline length primitive 부재
 */
export const DRIVEN_ONLY_DIMENSION_TYPES: ReadonlySet<DimensionConstraintType> = new Set([
  "ellipse_major_radius",
  "curve_length",
]);

export const EMPTY_CONSTRAINT_APPLICABILITY: ConstraintApplicability = {
  coincident: false,
  horizontal: false,
  vertical: false,
  fix: false,
  equal: false,
  parallel: false,
  perpendicular: false,
  tangent: false,
  midpoint: false,
  concentric: false,
  colinear: false,
  point_on_circle: false,
  equal_radius: false,
  symmetric: false,
  equidistant: false,
  fix_together: false,
};

/**
 * CATIA 식 통합 "점-선택" 모델 — vertex (다른 기하의 endpoint) 와 point geometry
 * (Point 도구로 그린 독립 점) 를 단일 SelectedPoint 로 통합.
 *
 * 모든 constraint 조건과 생성 로직이 selPoints 만 카운팅 → vertex / point 케이스 일관 처리.
 * geomId / vertexIndex 가 ConstraintPointRef 와 호환.
 */
export type SelectedPoint = {
  source: "vertex" | "point";
  geomId: string;
  vertexIndex: number; // point geometry 는 0
  x: number;
  y: number;
};

const toPointRef = (p: SelectedPoint): ConstraintPointRef => ({
  geomId: p.geomId,
  vertexIndex: p.vertexIndex,
});

// 통합 selection에서 vertex와 geometry를 추출하는 헬퍼
// override: 외부에서 직접 selection 전달 가능 (store 변경 없이 dimension 감지)
function extractSelection(store: SketchGeometryStore, override?: {
  selectedIds: string[];
  selectedVertices: VertexHandle[];
}): {
  verts: VertexHandle[];
  geoms: SerializedGeometry[];
  points: SerializedGeometry[];
  lines: SerializedGeometry[];
  circles: SerializedGeometry[];
  /** vertex + point geometry 통합 — CATIA 식 일관 처리. 같은 위치를 가리키는 두 source. */
  selPoints: SelectedPoint[];
  /** point geometry 가 아닌 geom 수 (line / circle / arc / ellipse / curve). */
  nonPointGeomCount: number;
} {
  const verts = override?.selectedVertices ?? store.selectedVertices;
  const ids = override?.selectedIds ?? store.selectedIds;
  const geoms = ids
    .map((id) => store.geometries.get(id))
    .filter(Boolean) as SerializedGeometry[];
  const points = geoms.filter((g) => g.type === "point");
  const lines = geoms.filter((g) => g.type === "line");
  const circles = geoms.filter((g) => g.type === "circle" || g.type === "arc");
  const selPoints: SelectedPoint[] = [];
  for (const v of verts) {
    selPoints.push({ source: "vertex", geomId: v.geomId, vertexIndex: v.vertexIndex, x: v.x, y: v.y });
  }
  for (const p of points) {
    if (p.type === "point") {
      selPoints.push({ source: "point", geomId: p.id, vertexIndex: 0, x: p.x, y: p.y });
    }
  }
  return { verts, geoms, points, lines, circles, selPoints, nonPointGeomCount: geoms.length - points.length };
}

/**
 * 현재 선택 상태로부터 적용 가능한 구속 타입을 판별 — CATIA 식 vertex/point 통합 처리.
 * selPoints (vertex + point geometry 통합) 카운팅 기반 → 케이스 일관성 보장.
 */
export function getConstraintApplicability(store: SketchGeometryStore): ConstraintApplicability {
  const { selPoints, lines, circles, nonPointGeomCount, geoms } = extractSelection(store);
  const pc = selPoints.length;
  const lc = lines.length;
  const cc = circles.length;

  // 두 selPoints 가 같은 기하의 vertex 면 coincident / h_pp / v_pp 비활성 (zero-length 의미).
  const diffSelPoints = pc === 2 && selPoints[0].geomId !== selPoints[1].geomId;

  // coincident: 2 selPoints (다른 기하) / 1 selPoint + 1 line (point-on-line)
  const canCoincident = diffSelPoints || (pc === 1 && lc === 1 && nonPointGeomCount === 1);

  // tangent: (1line + 1circle/arc) 또는 (2 circle/arc)
  const canTangent = pc === 0 && nonPointGeomCount === 2 && (
    (lc === 1 && cc === 1) || cc === 2
  );

  return {
    coincident: canCoincident,
    fix: pc === 1 && nonPointGeomCount === 0,
    midpoint: pc === 1 && lc === 1 && nonPointGeomCount === 1,
    point_on_circle: pc === 1 && cc === 1 && nonPointGeomCount === 1,
    // symmetric: 2 selPoints + axis(line) 또는 3 selPoints (center 형식 symmetric_point)
    symmetric: (pc === 2 && lc === 1 && nonPointGeomCount === 1) || (pc === 3 && nonPointGeomCount === 0),

    // line 1개 단독 또는 2 selPoints (점-점 수평/수직 — planegcs horizontal_pp / vertical_pp)
    horizontal: (pc === 0 && lc === 1 && nonPointGeomCount === 1) || diffSelPoints,
    vertical: (pc === 0 && lc === 1 && nonPointGeomCount === 1) || diffSelPoints,
    equal: pc === 0 && lc === 2 && nonPointGeomCount === 2,
    parallel: pc === 0 && lc === 2 && nonPointGeomCount === 2,
    perpendicular: pc === 0 && lc === 2 && nonPointGeomCount === 2,
    tangent: canTangent,
    concentric: pc === 0 && cc === 2 && nonPointGeomCount === 2,
    colinear: pc === 0 && lc === 2 && nonPointGeomCount === 2,
    equal_radius: pc === 0 && cc === 2 && nonPointGeomCount === 2,

    // equidistant: 3 selPoints (A, B, center)
    equidistant: pc === 3 && nonPointGeomCount === 0,
    // fix_together: 2개 이상 기하 선택 (point geometry 포함)
    fix_together: geoms.length >= 2,
  };
}

/**
 * 선택 상태 + 구속 타입 → SketchConstraint 생성 — CATIA 식 통합 selPoints 기반.
 * vertex / point 어느 source 든 동일 분기.
 */
export function createConstraintFromSelection(
  type: SketchConstraint["type"],
  store: SketchGeometryStore,
): SketchConstraint | null {
  const { geoms, lines, circles, selPoints } = extractSelection(store);
  const id = generateConstraintId();

  switch (type) {
    case "coincident": {
      // 2 selPoints (다른 기하) → point-to-point
      if (selPoints.length === 2 && selPoints[0].geomId !== selPoints[1].geomId) {
        return { type: "coincident", id,
          pointA: toPointRef(selPoints[0]),
          pointB: toPointRef(selPoints[1]) };
      }
      // 1 selPoint + 1 line → point-on-line
      if (selPoints.length === 1 && lines.length === 1) {
        return { type: "point_on_line", id,
          point: toPointRef(selPoints[0]),
          line: { geomId: lines[0].id } };
      }
      return null;
    }
    case "fix": {
      if (selPoints.length === 1) {
        return { type: "fix", id,
          point: toPointRef(selPoints[0]),
          x: selPoints[0].x, y: selPoints[0].y };
      }
      return null;
    }
    case "horizontal": {
      const line = lines[0];
      if (line && selPoints.length === 0) return { type: "horizontal", id, line: { geomId: line.id } };
      // 2 selPoints — 점-점 수평 (planegcs horizontal_pp).
      if (selPoints.length === 2 && selPoints[0].geomId !== selPoints[1].geomId) {
        return { type: "horizontal_pp", id,
          pointA: toPointRef(selPoints[0]),
          pointB: toPointRef(selPoints[1]) };
      }
      return null;
    }
    case "vertical": {
      const line = lines[0];
      if (line && selPoints.length === 0) return { type: "vertical", id, line: { geomId: line.id } };
      if (selPoints.length === 2 && selPoints[0].geomId !== selPoints[1].geomId) {
        return { type: "vertical_pp", id,
          pointA: toPointRef(selPoints[0]),
          pointB: toPointRef(selPoints[1]) };
      }
      return null;
    }
    case "equal": {
      if (lines.length !== 2) return null;
      return { type: "equal", id, lineA: { geomId: lines[0].id }, lineB: { geomId: lines[1].id } };
    }
    case "parallel": {
      if (lines.length !== 2) return null;
      return { type: "parallel", id, lineA: { geomId: lines[0].id }, lineB: { geomId: lines[1].id } };
    }
    case "perpendicular": {
      if (lines.length !== 2) return null;
      return { type: "perpendicular", id, lineA: { geomId: lines[0].id }, lineB: { geomId: lines[1].id } };
    }
    case "colinear": {
      if (lines.length !== 2) return null;
      return { type: "colinear", id, lineA: { geomId: lines[0].id }, lineB: { geomId: lines[1].id } };
    }
    case "concentric": {
      if (circles.length !== 2) return null;
      return { type: "concentric", id, circleA: { geomId: circles[0].id }, circleB: { geomId: circles[1].id } };
    }
    case "tangent": {
      if (geoms.length !== 2) return null;
      const valid = geoms.every((g) => g.type === "line" || g.type === "circle" || g.type === "arc");
      const hasCircle = geoms.some((g) => g.type === "circle" || g.type === "arc");
      if (!valid || !hasCircle) return null;
      return { type: "tangent", id, entityA: { geomId: geoms[0].id }, entityB: { geomId: geoms[1].id } };
    }
    case "equal_radius": {
      if (circles.length !== 2) return null;
      return { type: "equal_radius", id, circleA: { geomId: circles[0].id }, circleB: { geomId: circles[1].id } };
    }
    case "midpoint": {
      if (selPoints.length !== 1 || lines.length !== 1) return null;
      return { type: "midpoint", id,
        point: toPointRef(selPoints[0]),
        line: { geomId: lines[0].id } };
    }
    case "point_on_circle": {
      if (selPoints.length !== 1 || circles.length !== 1) return null;
      return { type: "point_on_circle", id,
        point: toPointRef(selPoints[0]),
        circle: { geomId: circles[0].id } };
    }
    case "point_on_line": {
      if (selPoints.length !== 1 || lines.length !== 1) return null;
      return { type: "point_on_line", id,
        point: toPointRef(selPoints[0]),
        line: { geomId: lines[0].id } };
    }
    case "symmetric": {
      // axis = line: 일반 symmetric. axis = point (selPoints 3개): symmetric_point (CATIA 점 기준 대칭).
      if (selPoints.length === 2 && lines.length === 1) {
        return { type: "symmetric", id,
          pointA: toPointRef(selPoints[0]),
          pointB: toPointRef(selPoints[1]),
          axis: { geomId: lines[0].id } };
      }
      if (selPoints.length === 3) {
        return { type: "symmetric_point", id,
          pointA: toPointRef(selPoints[0]),
          pointB: toPointRef(selPoints[1]),
          center: toPointRef(selPoints[2]) };
      }
      return null;
    }
    case "equidistant": {
      if (selPoints.length !== 3) return null;
      return { type: "equidistant", id,
        pointA: toPointRef(selPoints[0]),
        pointB: toPointRef(selPoints[1]),
        center: toPointRef(selPoints[2]) };
    }
    case "fix_together": {
      // 2개 이상 기하: 상대 위치 고정 (매크로 — 쌍별 distance 구속)
      if (geoms.length < 2) return null;
      return { type: "fix_together", id,
        elements: geoms.map((g) => ({ geomId: g.id })) };
    }
    default:
      return null;
  }
}

/**
 * 선택 상태 → dimension 구속 타입 자동 감지
 * 통합 selection 기반 단일 경로
 */
export function getDimensionConstraintType(store: SketchGeometryStore, override?: {
  selectedIds: string[];
  selectedVertices: VertexHandle[];
}): DimensionConstraintType | null {
  const { geoms, lines, circles, selPoints, nonPointGeomCount } = extractSelection(store, override);
  const pc = selPoints.length;

  // 참조 geometry (원점 / H-axis / V-axis) 자체에는 길이 / 반지름 dimension 의미 없음.
  // 단, ref + non-ref 조합 (예: 점→원점 distance, 점→축 point_line_distance, line↔축 angle)
  // 은 유효 — 아래 multi-element 분기에서 자연스럽게 처리됨. blanket skip 하지 않음.

  // --- 단일 요소 자동 감지 (1 geometry body, 0 selPoints) ---
  if (pc === 0 && geoms.length === 1) {
    const g = geoms[0];
    // 단일 reference 단독 선택은 dimension 무의미 (axis length / origin diameter 등)
    if ("isReference" in g && g.isReference) return null;
    if (g.type === "line") return "line_length";
    if (g.type === "circle") return "diameter";
    if (g.type === "arc") return "radius";
    // ellipse_major_radius / curve_length 는 planegcs 미지원 (radmaj derived / BSpline length
    // primitive 부재) — UI 입력 자체 차단. ellipse_minor_radius 도 자동 추론 흐름에서 제외.
    if (g.type === "ellipse") return null;
    if (g.type === "curve") return null;
  }

  // CATIA 식 통합 점 처리 — vertex / point 어느 source 든 selPoints 로.
  // 2 selPoints → distance
  if (pc === 2 && nonPointGeomCount === 0) return "distance";
  // 1 selPoint + 1 line → point_line_distance
  if (pc === 1 && lines.length === 1 && nonPointGeomCount === 1) return "point_line_distance";
  // 1 selPoint + 1 circle/arc → point_circle_distance
  if (pc === 1 && circles.length === 1 && nonPointGeomCount === 1) return "point_circle_distance";
  // line 1 + circle/arc 1 → line_circle_distance
  if (pc === 0 && lines.length === 1 && circles.length === 1 && nonPointGeomCount === 2) return "line_circle_distance";
  // circle/arc 2 → circle_circle_distance
  if (pc === 0 && circles.length === 2 && nonPointGeomCount === 2) return "circle_circle_distance";
  // line 2 → 평행이면 line_line_distance, 비평행이면 angle
  if (pc === 0 && lines.length === 2 && nonPointGeomCount === 2) {
    const l1 = lines[0], l2 = lines[1];
    if (l1.type === "line" && l2.type === "line") {
      const d1x = l1.x2 - l1.x1, d1y = l1.y2 - l1.y1;
      const d2x = l2.x2 - l2.x1, d2y = l2.y2 - l2.y1;
      const len1 = Math.hypot(d1x, d1y), len2 = Math.hypot(d2x, d2y);
      if (len1 > 1e-9 && len2 > 1e-9) {
        const cross = Math.abs(d1x * d2y - d1y * d2x) / (len1 * len2);
        if (cross < 0.035) return "line_line_distance"; // ~2° 이내 → 평행 → 두 line 사이 거리
      }
    }
    return "angle";
  }
  // circle/arc 1개 (multi-selection 경로에서도 처리) → radius
  if (pc === 0 && circles.length === 1 && nonPointGeomCount === 1) return "radius";

  return null;
}

/**
 * dimension 타입별 현재 값 계산 (패널 기본값)
 * 통합 selection 기반
 */
export function computeDimensionDefaultValue(type: DimensionConstraintType, store: SketchGeometryStore, override?: {
  selectedIds: string[];
  selectedVertices: VertexHandle[];
}): number {
  const { geoms, lines, circles, selPoints } = extractSelection(store, override);

  if (type === "distance") {
    if (selPoints.length === 2) {
      return Math.hypot(selPoints[1].x - selPoints[0].x, selPoints[1].y - selPoints[0].y);
    }
    return 0;
  }

  if (type === "horizontal_distance") {
    if (selPoints.length === 2) return Math.abs(selPoints[1].x - selPoints[0].x);
    return 0;
  }

  if (type === "vertical_distance") {
    if (selPoints.length === 2) return Math.abs(selPoints[1].y - selPoints[0].y);
    return 0;
  }

  if (type === "line_length") {
    const line = lines[0];
    if (line?.type === "line") return Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    return 0;
  }

  if (type === "line_angle") {
    const line = lines[0];
    if (line?.type === "line") {
      const dx = line.x2 - line.x1;
      const dy = line.y2 - line.y1;
      if (Math.hypot(dx, dy) < 1e-9) return 0;
      return Math.atan2(dy, dx) * 180 / Math.PI;
    }
    return 0;
  }

  if (type === "angle") {
    if (lines.length === 2 && lines[0].type === "line" && lines[1].type === "line") {
      const lA = lines[0], lB = lines[1];
      const dxA = lA.x2 - lA.x1, dyA = lA.y2 - lA.y1;
      const dxB = lB.x2 - lB.x1, dyB = lB.y2 - lB.y1;
      const magA = Math.hypot(dxA, dyA), magB = Math.hypot(dxB, dyB);
      if (magA < 1e-9 || magB < 1e-9) return 90;
      // CATIA 식 무방향: |cos| 으로 line direction 무관 사잇각 (0~90°) 반환.
      // 라벨 위치 결정 후 computeAngleFromLabelPos 가 사잇각/보각 (0~180°) 으로 갱신.
      const cosAngle = Math.max(-1, Math.min(1, Math.abs(dxA * dxB + dyA * dyB) / (magA * magB)));
      return Math.acos(cosAngle) * 180 / Math.PI;
    }
    return 0;
  }

  if (type === "radius") {
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    if (circle && (circle.type === "circle" || circle.type === "arc")) return circle.r;
    return 0;
  }

  if (type === "diameter") {
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    if (circle && (circle.type === "circle" || circle.type === "arc")) return circle.r * 2;
    return 0;
  }

  if (type === "point_line_distance") {
    if (selPoints.length !== 1) return 0;
    const { x: px, y: py } = selPoints[0];
    const line = lines[0];
    if (!line || line.type !== "line") return 0;
    return pointToLineDistance({ x: px, y: py }, line.x1, line.y1, line.x2, line.y2);
  }

  if (type === "line_line_distance") {
    // 평행 두 line 사이 거리 — line[0] 의 시작점에서 line[1] 의 무한 직선까지의 수직 거리.
    const lineA = lines[0], lineB = lines[1];
    if (!lineA || lineA.type !== "line" || !lineB || lineB.type !== "line") return 0;
    return pointToLineDistance({ x: lineA.x1, y: lineA.y1 }, lineB.x1, lineB.y1, lineB.x2, lineB.y2);
  }

  if (type === "point_circle_distance") {
    // 점에서 원/호 둘레까지의 외부 거리 (= dist(p, center) - r). 점이 내부면 음수 가능.
    if (selPoints.length !== 1) return 0;
    const { x: px, y: py } = selPoints[0];
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    if (!circle || (circle.type !== "circle" && circle.type !== "arc")) return 0;
    const d = Math.hypot(px - circle.cx, py - circle.cy);
    return Math.abs(d - circle.r);
  }

  if (type === "line_circle_distance") {
    // line 과 원/호 둘레 사이 외부 거리 (= |dist(center, line) - r|).
    const line = lines[0];
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    if (!line || line.type !== "line" || !circle || (circle.type !== "circle" && circle.type !== "arc")) return 0;
    const d = pointToLineDistance({ x: circle.cx, y: circle.cy }, line.x1, line.y1, line.x2, line.y2);
    return Math.abs(d - circle.r);
  }

  if (type === "circle_circle_distance") {
    // 두 원/호 사이 외부 거리 (= dist(centerA, centerB) - rA - rB).
    const cA = circles[0], cB = circles[1];
    if (!cA || !cB || (cA.type !== "circle" && cA.type !== "arc") || (cB.type !== "circle" && cB.type !== "arc")) return 0;
    const d = Math.hypot(cA.cx - cB.cx, cA.cy - cB.cy);
    return Math.abs(d - cA.r - cB.r);
  }

  if (type === "arc_length") {
    // 호 길이 = sweep × radius
    const arc = geoms.find((g) => g.type === "arc");
    if (arc && arc.type === "arc") {
      let span = arc.endAngle - arc.startAngle;
      if (span <= 0) span += Math.PI * 2;
      return span * arc.r;
    }
    return 0;
  }

  if (type === "ellipse_major_radius") {
    const e = geoms.find((g) => g.type === "ellipse");
    if (e && e.type === "ellipse") return Math.max(e.rx, e.ry);
    return 0;
  }

  if (type === "ellipse_minor_radius") {
    const e = geoms.find((g) => g.type === "ellipse");
    if (e && e.type === "ellipse") return Math.min(e.rx, e.ry);
    return 0;
  }

  if (type === "curve_length") {
    // NURBS evaluated polyline 의 segment 길이 합.
    const cv = geoms.find((g) => g.type === "curve");
    if (cv && cv.type === "curve") {
      // 정확 sum 은 nurbsEvaluate 호출 필요 — 여기서는 control points 의 polyline 길이로 근사.
      // 실제 length 는 driven-only 로 솔버 패스 — live value 가 정확한 nurbs sum.
      let len = 0;
      for (let i = 0; i < cv.points.length - 1; i++) {
        len += Math.hypot(cv.points[i + 1].x - cv.points[i].x, cv.points[i + 1].y - cv.points[i].y);
      }
      return len;
    }
    return 0;
  }

  return 0;
}

/**
 * 두 선 + 라벨 위치 → angle constraint 의 표시/저장 각도 (degree, 0~180).
 *
 * **CATIA 식 무방향 line 동작**:
 * - 사용자가 그린 line direction (vertex 0→1) 과 무관 — 시각적 동일하면 결과 동일.
 * - line direction 을 라벨 방향으로 normalize 한 뒤 영역 판정.
 *
 * 결과:
 * - 라벨이 두 line 사이 사잇각 영역 → 사잇각 (β, 0~90)
 * - 라벨이 보각 영역 (line 의 반대 끝 쪽) → 보각 (180-β, 90~180)
 *
 * 반사각 (180+β) / 보반사각 (360-β) 같은 큰 각도는 자동 분기 안 함 — 사용자가 명시적으로
 * DimensionPanel 에서 직접 입력해야 함 (CATIA 표준).
 *
 * @returns 0~180 의 표시 각도. 평행 / degenerate 시 null.
 */
export function computeAngleFromLabelPos(
  lineA: Extract<SerializedGeometry, { type: "line" }>,
  lineB: Extract<SerializedGeometry, { type: "line" }>,
  labelPos: { x: number; y: number },
): number | null {
  // 두 직선의 교점
  const denom = (lineA.x1 - lineA.x2) * (lineB.y1 - lineB.y2) - (lineA.y1 - lineA.y2) * (lineB.x1 - lineB.x2);
  if (Math.abs(denom) < 1e-10) return null; // 평행
  const t = ((lineA.x1 - lineB.x1) * (lineB.y1 - lineB.y2) - (lineA.y1 - lineB.y1) * (lineB.x1 - lineB.x2)) / denom;
  const cx = lineA.x1 + t * (lineA.x2 - lineA.x1);
  const cy = lineA.y1 + t * (lineA.y2 - lineA.y1);

  const offX = labelPos.x - cx, offY = labelPos.y - cy;
  if (offX * offX + offY * offY < 1e-12) return null;

  let dxA = lineA.x2 - lineA.x1, dyA = lineA.y2 - lineA.y1;
  let dxB = lineB.x2 - lineB.x1, dyB = lineB.y2 - lineB.y1;
  if (Math.hypot(dxA, dyA) < 1e-9 || Math.hypot(dxB, dyB) < 1e-9) return null;

  // CATIA 식 line direction normalize:
  // 라벨이 line 의 음의 방향 (dot < 0) 에 가까우면 direction 뒤집기.
  // 결과: 두 line 모두 양의 방향이 라벨 쪽 → 사용자가 그린 line direction 과 무관.
  if (dxA * offX + dyA * offY < 0) { dxA = -dxA; dyA = -dyA; }
  if (dxB * offX + dyB * offY < 0) { dxB = -dxB; dyB = -dyB; }

  // normalize 후 cross product 부호로 영역 판정
  const sideA = dxA * offY - dyA * offX;
  const sideB = dxB * offY - dyB * offX;

  // 두 line 의 양의 방향 사이의 사잇각 (acos 기반, 0~π)
  const lenA = Math.hypot(dxA, dyA), lenB = Math.hypot(dxB, dyB);
  const cosAB = Math.max(-1, Math.min(1, (dxA * dxB + dyA * dyB) / (lenA * lenB)));
  const acuteRad = Math.acos(cosAB);

  // 영역 판정 (2가지):
  // - 부호 다름: 두 line 의 양의 방향 wedge 안 (사잇각 영역) → β
  // - 부호 같음: 두 line 의 양의 방향이 라벨 같은 쪽 (보각 영역) → 180 - β
  const isAcute = sideA * sideB < 0;
  const displayRad = isAcute ? acuteRad : (Math.PI - acuteRad);

  return displayRad * 180 / Math.PI;
}

/**
 * dimension 구속 생성 (통합 selection 기반)
 */
export function createDimensionConstraint(
  type: DimensionConstraintType,
  store: SketchGeometryStore,
  value: number,
): SketchConstraint | null {
  const c = _createDimensionConstraintInternal(type, store, value);
  // driven-only type 자동으로 isReference=true (사용자가 enforce 시도해도 사실상 무시).
  if (c && DRIVEN_ONLY_DIMENSION_TYPES.has(type)) {
    (c as { isReference?: boolean }).isReference = true;
  }
  return c;
}

function _createDimensionConstraintInternal(
  type: DimensionConstraintType,
  store: SketchGeometryStore,
  value: number,
): SketchConstraint | null {
  if (type !== "line_angle" && value <= 0) return null;
  // angle 은 0 < value < 360 허용 — 라벨 위치별로 사잇각 / 보각 / 반사각 / 보반사각 표현.
  if (type === "angle" && value >= 360) return null;

  const { lines, geoms, circles, selPoints } = extractSelection(store);
  const id = generateConstraintId();

  if (type === "distance") {
    if (selPoints.length === 2) {
      return { type: "distance", id,
        pointA: toPointRef(selPoints[0]),
        pointB: toPointRef(selPoints[1]),
        value };
    }
    return null;
  }

  if (type === "horizontal_distance") {
    // sign: 생성 시점의 좌표 대소관계 기록 (드래그 중 flip 방지)
    if (selPoints.length === 2) {
      const hSign: 1 | -1 = (selPoints[1].x >= selPoints[0].x) ? 1 : -1;
      return { type: "horizontal_distance", id,
        pointA: toPointRef(selPoints[0]),
        pointB: toPointRef(selPoints[1]),
        value, sign: hSign };
    }
    return null;
  }

  if (type === "vertical_distance") {
    if (selPoints.length === 2) {
      const vSign: 1 | -1 = (selPoints[1].y >= selPoints[0].y) ? 1 : -1;
      return { type: "vertical_distance", id,
        pointA: toPointRef(selPoints[0]),
        pointB: toPointRef(selPoints[1]),
        value, sign: vSign };
    }
    return null;
  }

  if (type === "line_length") {
    const line = lines[0];
    return line ? { type: "line_length", id, line: { geomId: line.id }, value } : null;
  }

  if (type === "line_angle") {
    const line = lines[0];
    return line ? { type: "line_angle", id, line: { geomId: line.id }, value } : null;
  }

  if (type === "angle") {
    if (lines.length !== 2) return null;
    return { type: "angle", id, lineA: { geomId: lines[0].id }, lineB: { geomId: lines[1].id }, value };
  }

  if (type === "radius") {
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    return circle ? { type: "radius", id, circle: { geomId: circle.id }, value } : null;
  }

  if (type === "diameter") {
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    return circle ? { type: "diameter", id, circle: { geomId: circle.id }, value } : null;
  }

  if (type === "point_line_distance") {
    if (selPoints.length === 1 && lines.length === 1) {
      return { type: "point_line_distance", id,
        point: toPointRef(selPoints[0]),
        line: { geomId: lines[0].id }, value };
    }
    return null;
  }

  if (type === "line_line_distance") {
    if (lines.length === 2) {
      return { type: "line_line_distance", id,
        lineA: { geomId: lines[0].id },
        lineB: { geomId: lines[1].id },
        value };
    }
    return null;
  }

  if (type === "point_circle_distance") {
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    if (!circle || selPoints.length !== 1) return null;
    return { type: "point_circle_distance", id,
      point: toPointRef(selPoints[0]),
      circle: { geomId: circle.id }, value };
  }

  if (type === "line_circle_distance") {
    const line = lines[0];
    const circle = geoms.find((g) => g.type === "circle" || g.type === "arc");
    if (!line || !circle) return null;
    return { type: "line_circle_distance", id, line: { geomId: line.id }, circle: { geomId: circle.id }, value };
  }

  if (type === "circle_circle_distance") {
    if (circles.length !== 2) return null;
    return { type: "circle_circle_distance", id,
      circleA: { geomId: circles[0].id },
      circleB: { geomId: circles[1].id },
      value };
  }

  if (type === "arc_length") {
    const arc = geoms.find((g) => g.type === "arc");
    return arc ? { type: "arc_length", id, arc: { geomId: arc.id }, value } : null;
  }

  if (type === "ellipse_major_radius") {
    const e = geoms.find((g) => g.type === "ellipse");
    return e ? { type: "ellipse_major_radius", id, ellipse: { geomId: e.id }, value } : null;
  }

  if (type === "ellipse_minor_radius") {
    const e = geoms.find((g) => g.type === "ellipse");
    return e ? { type: "ellipse_minor_radius", id, ellipse: { geomId: e.id }, value } : null;
  }

  if (type === "curve_length") {
    const cv = geoms.find((g) => g.type === "curve");
    return cv ? { type: "curve_length", id, curve: { geomId: cv.id }, value } : null;
  }

  return null;
}

/**
 * 현재 selection 에 대해 이미 적용된 constraint 타입 Set 반환.
 * Toolbar 의 toggle active 표시에 사용.
 */
export function getAppliedConstraintTypes(store: SketchGeometryStore): Set<SketchConstraint["type"]> {
  const result = new Set<SketchConstraint["type"]>();
  const cStore = store.constraintStore;
  if (!cStore) return result;

  // 적용 가능한 타입에 대해서만 검사 — 불필요한 createConstraintFromSelection 회피
  const applicability = getConstraintApplicability(store);
  // ConstraintApplicability 의 key 만 — applicability 가 true 인 타입은 적용 시도 가능
  const candidateTypes: SketchConstraint["type"][] = [
    "coincident", "horizontal", "vertical", "fix", "equal", "parallel", "perpendicular",
    "tangent", "midpoint", "concentric", "colinear", "point_on_circle",
    "equal_radius", "symmetric", "equidistant", "fix_together",
  ];
  for (const type of candidateTypes) {
    const key = type as keyof ConstraintApplicability;
    if (!applicability[key]) continue;
    const candidate = createConstraintFromSelection(type, store);
    if (!candidate) continue;
    if (findEquivalentConstraint(candidate, cStore.constraints)) {
      result.add(type);
    }
  }
  return result;
}

// ── 같은 선택에 대한 동일 constraint 탐색 (toggle 동작용) ──────────────────

/**
 * candidate 와 동일한 reference 를 가진 기존 constraint 를 store 에서 찾기.
 * 같으면 reference 가 swap 된 경우 (e.g., parallel(a,b) ≡ parallel(b,a)) 도 매칭.
 * 반환: 매칭되는 기존 constraint, 없으면 null.
 *
 * 용도: toolbar 에서 같은 constraint 버튼 두 번 누르면 toggle off (제거) 처리.
 */
export function findEquivalentConstraint(
  candidate: SketchConstraint,
  constraints: Map<string, SketchConstraint>,
): SketchConstraint | null {
  for (const c of constraints.values()) {
    if (c.type !== candidate.type) continue;
    if (_constraintsEquivalent(c, candidate)) return c;
  }
  return null;
}

function _constraintsEquivalent(a: SketchConstraint, b: SketchConstraint): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "horizontal":
    case "vertical": {
      const bb = b as typeof a;
      return a.line.geomId === bb.line.geomId;
    }
    case "horizontal_pp":
    case "vertical_pp":
    case "symmetric_point": {
      const bb = b as typeof a;
      const samePair = (
        a.pointA.geomId === bb.pointA.geomId && a.pointA.vertexIndex === bb.pointA.vertexIndex &&
        a.pointB.geomId === bb.pointB.geomId && a.pointB.vertexIndex === bb.pointB.vertexIndex
      ) || (
        a.pointA.geomId === bb.pointB.geomId && a.pointA.vertexIndex === bb.pointB.vertexIndex &&
        a.pointB.geomId === bb.pointA.geomId && a.pointB.vertexIndex === bb.pointA.vertexIndex
      );
      if (a.type !== "symmetric_point") return samePair;
      const aSP = a as Extract<SketchConstraint, { type: "symmetric_point" }>;
      const bSP = bb as Extract<SketchConstraint, { type: "symmetric_point" }>;
      return samePair
        && aSP.center.geomId === bSP.center.geomId
        && aSP.center.vertexIndex === bSP.center.vertexIndex;
    }
    case "fix": {
      const bb = b as typeof a;
      return a.point.geomId === bb.point.geomId && a.point.vertexIndex === bb.point.vertexIndex;
    }
    case "coincident":
    case "distance":
    case "horizontal_distance":
    case "vertical_distance":
    case "symmetric":
    case "equidistant": {
      // p2p — symmetric A↔B
      const bb = b as typeof a;
      const eq = (
        a.pointA.geomId === bb.pointA.geomId && a.pointA.vertexIndex === bb.pointA.vertexIndex &&
        a.pointB.geomId === bb.pointB.geomId && a.pointB.vertexIndex === bb.pointB.vertexIndex
      ) || (
        a.pointA.geomId === bb.pointB.geomId && a.pointA.vertexIndex === bb.pointB.vertexIndex &&
        a.pointB.geomId === bb.pointA.geomId && a.pointB.vertexIndex === bb.pointA.vertexIndex
      );
      return eq;
    }
    case "parallel":
    case "perpendicular":
    case "equal":
    case "colinear":
    case "angle": {
      // 같은 line 쌍에 angle dim 이 이미 있으면 value/isAcute 와 무관하게 toggle off 대상으로 간주.
      // CATIA 와 동일 — 한 line 쌍에 하나의 angle dim 만 허용 (사잇각 vs 보각은 별 dim 이 아니라 같은
      // dim 의 zone 표현). 사용자가 같은 쌍에 새 angle 을 적용하면 기존이 제거됨.
      const bb = b as typeof a;
      return (a.lineA.geomId === bb.lineA.geomId && a.lineB.geomId === bb.lineB.geomId)
          || (a.lineA.geomId === bb.lineB.geomId && a.lineB.geomId === bb.lineA.geomId);
    }
    case "tangent": {
      const bb = b as typeof a;
      return (a.entityA.geomId === bb.entityA.geomId && a.entityB.geomId === bb.entityB.geomId)
          || (a.entityA.geomId === bb.entityB.geomId && a.entityB.geomId === bb.entityA.geomId);
    }
    case "concentric":
    case "equal_radius": {
      const bb = b as typeof a;
      return (a.circleA.geomId === bb.circleA.geomId && a.circleB.geomId === bb.circleB.geomId)
          || (a.circleA.geomId === bb.circleB.geomId && a.circleB.geomId === bb.circleA.geomId);
    }
    case "midpoint":
    case "point_on_line":
    case "point_line_distance": {
      const bb = b as typeof a;
      return a.point.geomId === bb.point.geomId
          && a.point.vertexIndex === bb.point.vertexIndex
          && a.line.geomId === bb.line.geomId;
    }
    case "point_on_circle": {
      const bb = b as typeof a;
      return a.point.geomId === bb.point.geomId
          && a.point.vertexIndex === bb.point.vertexIndex
          && a.circle.geomId === bb.circle.geomId;
    }
    case "radius":
    case "diameter": {
      const bb = b as typeof a;
      return a.circle.geomId === bb.circle.geomId;
    }
    case "line_length":
    case "line_angle": {
      const bb = b as typeof a;
      return a.line.geomId === bb.line.geomId;
    }
    case "fix_together": {
      const bb = b as typeof a;
      if (a.elements.length !== bb.elements.length) return false;
      const aIds = new Set(a.elements.map((e) => e.geomId));
      return bb.elements.every((e) => aIds.has(e.geomId));
    }
    case "line_line_distance": {
      const bb = b as typeof a;
      return (a.lineA.geomId === bb.lineA.geomId && a.lineB.geomId === bb.lineB.geomId)
          || (a.lineA.geomId === bb.lineB.geomId && a.lineB.geomId === bb.lineA.geomId);
    }
    case "point_circle_distance": {
      const bb = b as typeof a;
      return a.point.geomId === bb.point.geomId
          && a.point.vertexIndex === bb.point.vertexIndex
          && a.circle.geomId === bb.circle.geomId;
    }
    case "line_circle_distance": {
      const bb = b as typeof a;
      return a.line.geomId === bb.line.geomId && a.circle.geomId === bb.circle.geomId;
    }
    case "circle_circle_distance": {
      const bb = b as typeof a;
      return (a.circleA.geomId === bb.circleA.geomId && a.circleB.geomId === bb.circleB.geomId)
          || (a.circleA.geomId === bb.circleB.geomId && a.circleB.geomId === bb.circleA.geomId);
    }
    case "arc_length": {
      const bb = b as typeof a;
      return a.arc.geomId === bb.arc.geomId;
    }
    case "ellipse_major_radius":
    case "ellipse_minor_radius": {
      const bb = b as typeof a;
      return a.ellipse.geomId === bb.ellipse.geomId;
    }
    case "curve_length": {
      const bb = b as typeof a;
      return a.curve.geomId === bb.curve.geomId;
    }
    default:
      return false;
  }
}

/**
 * Constraint 가 참조하는 기하의 현재 좌표에서 dimension value 계산 (live value).
 * Driven (isReference) dimension 의 라벨 표시값에 사용 — 기하가 움직이면 자동 갱신.
 * 매핑 안 되는 타입은 null.
 */
export function computeDimensionLiveValue(
  c: SketchConstraint,
  geometries: Map<string, SerializedGeometry>,
): number | null {
  const vCoord = (ref: { geomId: string; vertexIndex: number }): { x: number; y: number } | null => {
    const g = geometries.get(ref.geomId);
    if (!g) return null;
    return getVertexCoord(g, ref.vertexIndex);
  };
  switch (c.type) {
    case "distance": {
      const a = vCoord(c.pointA), b = vCoord(c.pointB);
      return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null;
    }
    case "horizontal_distance": {
      const a = vCoord(c.pointA), b = vCoord(c.pointB);
      return a && b ? Math.abs(b.x - a.x) : null;
    }
    case "vertical_distance": {
      const a = vCoord(c.pointA), b = vCoord(c.pointB);
      return a && b ? Math.abs(b.y - a.y) : null;
    }
    case "line_length": {
      const g = geometries.get(c.line.geomId);
      if (g?.type !== "line") return null;
      return Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    }
    case "line_angle": {
      const g = geometries.get(c.line.geomId);
      if (g?.type !== "line") return null;
      const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
      if (Math.hypot(dx, dy) < 1e-9) return 0;
      return Math.atan2(dy, dx) * 180 / Math.PI;
    }
    case "angle": {
      const a = geometries.get(c.lineA.geomId);
      const b = geometries.get(c.lineB.geomId);
      if (a?.type !== "line" || b?.type !== "line") return null;
      // 라벨 위치 기반 영역 (사잇각/보각) 으로 live value 계산 — driven dim 의
      // c.value 와 같은 영역 표시 보장. line direction 무관.
      const labelPos = getEffectiveLabelPos(c, geometries);
      if (labelPos) {
        const fromLabel = computeAngleFromLabelPos(a, b, labelPos);
        if (fromLabel !== null) return fromLabel;
      }
      // fallback: 사잇각 (line direction 무관)
      const dxA = a.x2 - a.x1, dyA = a.y2 - a.y1;
      const dxB = b.x2 - b.x1, dyB = b.y2 - b.y1;
      const lenA = Math.hypot(dxA, dyA), lenB = Math.hypot(dxB, dyB);
      if (lenA < 1e-9 || lenB < 1e-9) return 0;
      const cos = Math.max(-1, Math.min(1, Math.abs(dxA * dxB + dyA * dyB) / (lenA * lenB)));
      return Math.acos(cos) * 180 / Math.PI;
    }
    case "radius": {
      const g = geometries.get(c.circle.geomId);
      if (g?.type !== "circle" && g?.type !== "arc") return null;
      return g.r;
    }
    case "diameter": {
      const g = geometries.get(c.circle.geomId);
      if (g?.type !== "circle" && g?.type !== "arc") return null;
      return g.r * 2;
    }
    case "point_line_distance": {
      const p = vCoord(c.point);
      const g = geometries.get(c.line.geomId);
      if (!p || g?.type !== "line") return null;
      return pointToLineDistance(p, g.x1, g.y1, g.x2, g.y2);
    }
    case "line_line_distance": {
      const a = geometries.get(c.lineA.geomId);
      const b = geometries.get(c.lineB.geomId);
      if (a?.type !== "line" || b?.type !== "line") return null;
      return pointToLineDistance({ x: a.x1, y: a.y1 }, b.x1, b.y1, b.x2, b.y2);
    }
    case "point_circle_distance": {
      const p = vCoord(c.point);
      const cir = geometries.get(c.circle.geomId);
      if (!p || (cir?.type !== "circle" && cir?.type !== "arc")) return null;
      return Math.abs(Math.hypot(p.x - cir.cx, p.y - cir.cy) - cir.r);
    }
    case "line_circle_distance": {
      const ln = geometries.get(c.line.geomId);
      const cir = geometries.get(c.circle.geomId);
      if (ln?.type !== "line" || (cir?.type !== "circle" && cir?.type !== "arc")) return null;
      const d = pointToLineDistance({ x: cir.cx, y: cir.cy }, ln.x1, ln.y1, ln.x2, ln.y2);
      return Math.abs(d - cir.r);
    }
    case "circle_circle_distance": {
      const a = geometries.get(c.circleA.geomId);
      const b = geometries.get(c.circleB.geomId);
      if ((a?.type !== "circle" && a?.type !== "arc") || (b?.type !== "circle" && b?.type !== "arc")) return null;
      return Math.abs(Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r);
    }
    case "arc_length": {
      const g = geometries.get(c.arc.geomId);
      if (g?.type !== "arc") return null;
      let span = g.endAngle - g.startAngle;
      if (span <= 0) span += Math.PI * 2;
      return span * g.r;
    }
    case "ellipse_major_radius": {
      const e = geometries.get(c.ellipse.geomId);
      if (e?.type !== "ellipse") return null;
      return Math.max(e.rx, e.ry);
    }
    case "ellipse_minor_radius": {
      const e = geometries.get(c.ellipse.geomId);
      if (e?.type !== "ellipse") return null;
      return Math.min(e.rx, e.ry);
    }
    case "curve_length": {
      const cv = geometries.get(c.curve.geomId);
      if (cv?.type !== "curve") return null;
      // control polygon 길이 (근사). 정확 NURBS arc length 는 별도 evaluation 필요.
      let len = 0;
      for (let i = 0; i < cv.points.length - 1; i++) {
        len += Math.hypot(cv.points[i + 1].x - cv.points[i].x, cv.points[i + 1].y - cv.points[i].y);
      }
      return len;
    }
    default:
      return null;
  }
}

// ── Label 상대좌표 (CATIA 식 — 기하 이동 시 라벨이 따라가도록) ──────────────

/**
 * Dimension constraint 의 라벨 reference 점 — labelOffset 의 anchor.
 *   - distance / h_distance / v_distance: 두 점의 중점
 *   - point_line_distance: 점 좌표
 *   - line_length / line_angle: line 의 중점
 *   - radius / diameter: circle/arc 의 중심
 *   - angle: 두 line midpoint 의 평균 (교점 대신 안정적인 위치)
 */
export function computeDimensionLabelReference(
  c: SketchConstraint,
  geometries: Map<string, SerializedGeometry>,
): { x: number; y: number } | null {
  switch (c.type) {
    case "distance":
    case "horizontal_distance":
    case "vertical_distance": {
      const ga = geometries.get(c.pointA.geomId);
      const gb = geometries.get(c.pointB.geomId);
      if (!ga || !gb) return null;
      const a = getVertexCoord(ga, c.pointA.vertexIndex);
      const b = getVertexCoord(gb, c.pointB.vertexIndex);
      return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    }
    case "line_length":
    case "line_angle": {
      const g = geometries.get(c.line.geomId);
      if (g?.type !== "line") return null;
      return { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 };
    }
    case "radius":
    case "diameter": {
      const g = geometries.get(c.circle.geomId);
      if (g?.type !== "circle" && g?.type !== "arc") return null;
      return { x: g.cx, y: g.cy };
    }
    case "angle": {
      const ga = geometries.get(c.lineA.geomId);
      const gb = geometries.get(c.lineB.geomId);
      if (ga?.type !== "line" || gb?.type !== "line") return null;
      const ax = (ga.x1 + ga.x2) / 2, ay = (ga.y1 + ga.y2) / 2;
      const bx = (gb.x1 + gb.x2) / 2, by = (gb.y1 + gb.y2) / 2;
      return { x: (ax + bx) / 2, y: (ay + by) / 2 };
    }
    case "point_line_distance": {
      const gp = geometries.get(c.point.geomId);
      if (!gp) return null;
      const p = getVertexCoord(gp, c.point.vertexIndex);
      return p ? { x: p.x, y: p.y } : null;
    }
    case "line_line_distance": {
      const lA = geometries.get(c.lineA.geomId);
      if (lA?.type !== "line") return null;
      return { x: (lA.x1 + lA.x2) / 2, y: (lA.y1 + lA.y2) / 2 };
    }
    case "point_circle_distance": {
      const gp = geometries.get(c.point.geomId);
      if (!gp) return null;
      const p = getVertexCoord(gp, c.point.vertexIndex);
      return p ? { x: p.x, y: p.y } : null;
    }
    case "line_circle_distance": {
      const ln = geometries.get(c.line.geomId);
      if (ln?.type !== "line") return null;
      return { x: (ln.x1 + ln.x2) / 2, y: (ln.y1 + ln.y2) / 2 };
    }
    case "circle_circle_distance": {
      const a = geometries.get(c.circleA.geomId);
      const b = geometries.get(c.circleB.geomId);
      if ((a?.type !== "circle" && a?.type !== "arc") || (b?.type !== "circle" && b?.type !== "arc")) return null;
      return { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 };
    }
    case "arc_length": {
      const arc = geometries.get(c.arc.geomId);
      if (arc?.type !== "arc") return null;
      let sweep = arc.endAngle - arc.startAngle;
      if (sweep <= 0) sweep += Math.PI * 2;
      const mid = arc.startAngle + sweep / 2;
      return { x: arc.cx + Math.cos(mid) * arc.r, y: arc.cy + Math.sin(mid) * arc.r };
    }
    case "ellipse_major_radius":
    case "ellipse_minor_radius": {
      const e = geometries.get(c.ellipse.geomId);
      if (e?.type !== "ellipse") return null;
      return { x: e.cx, y: e.cy };
    }
    case "curve_length": {
      const cv = geometries.get(c.curve.geomId);
      if (cv?.type !== "curve" || cv.points.length === 0) return null;
      const mid = cv.points[Math.floor(cv.points.length / 2)];
      return { x: mid.x, y: mid.y };
    }
    default:
      return null;
  }
}

/**
 * 효과적인 절대 라벨 좌표 — labelOffset (상대) 우선, 없으면 labelPos (레거시 절대) fallback.
 * 레거시 데이터: labelPos 만 있으면 그대로 절대로 사용.
 */
export function getEffectiveLabelPos(
  c: SketchConstraint,
  geometries: Map<string, SerializedGeometry>,
): { x: number; y: number } | undefined {
  const off = "labelOffset" in c && c.labelOffset
    ? (c.labelOffset as { x: number; y: number })
    : undefined;
  if (off) {
    const ref = computeDimensionLabelReference(c, geometries);
    if (ref) return { x: ref.x + off.x, y: ref.y + off.y };
  }
  if ("labelPos" in c && c.labelPos) {
    return c.labelPos as { x: number; y: number };
  }
  return undefined;
}
