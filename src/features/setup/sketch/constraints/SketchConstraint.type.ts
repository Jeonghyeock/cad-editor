// 스케치 구속조건 타입 정의

// 기하 꼭짓점 참조 (geomId + vertexIndex로 좌표 결정)
export type ConstraintPointRef = { geomId: string; vertexIndex: number };

// 기하 요소 참조 (line, circle 등)
export type ConstraintGeomRef = { geomId: string };

// Dimension 구속에 공통으로 사용되는 참조 전용 플래그
// isReference: true → 솔버 무시, 수치만 표시 (driven dimension)
// labelPos: 치수 텍스트 배치 좌표 (2D sketch 좌표 — 절대). 없으면 자동 위치. 레거시 / 호환용.
// labelOffset: 기하 기준점 (constraint 타입별 reference) 으로부터의 상대 오프셋. 존재 시
//   labelPos 보다 우선해서 사용 — 기하가 움직이면 라벨이 자동 따라감 (CATIA 식). 신규 dimension 부터.
// convertedByEE: true → 원래 enforced 였는데 EE 지정 때문에 임시로 ref 가 됨. EE 해제 시
//   복원 판단 (closed dim 만 enforced 로 되돌림). 사용자가 직접 만든 ref dim 과 구분용.
type DimensionRefFlag = {
  isReference?: boolean;
  isInternal?: boolean;
  labelPos?: { x: number; y: number };
  labelOffset?: { x: number; y: number };
  convertedByEE?: boolean;
};

// 구속조건 유니언 타입
export type SketchConstraint =
  | { type: "coincident"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef }
  | { type: "horizontal"; id: string; line: ConstraintGeomRef }
  | { type: "vertical"; id: string; line: ConstraintGeomRef }
  | { type: "horizontal_pp"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef }
  | { type: "vertical_pp"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef }
  | { type: "fix"; id: string; point: ConstraintPointRef; x: number; y: number }
  | { type: "distance"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef; value: number } & DimensionRefFlag
  | { type: "equal"; id: string; lineA: ConstraintGeomRef; lineB: ConstraintGeomRef }
  | { type: "parallel"; id: string; lineA: ConstraintGeomRef; lineB: ConstraintGeomRef }
  | { type: "perpendicular"; id: string; lineA: ConstraintGeomRef; lineB: ConstraintGeomRef }
  | { type: "tangent"; id: string; entityA: ConstraintGeomRef; entityB: ConstraintGeomRef }
  | { type: "midpoint"; id: string; point: ConstraintPointRef; line: ConstraintGeomRef }
  | { type: "point_on_line"; id: string; point: ConstraintPointRef; line: ConstraintGeomRef }
  | { type: "concentric"; id: string; circleA: ConstraintGeomRef; circleB: ConstraintGeomRef }
  | { type: "colinear"; id: string; lineA: ConstraintGeomRef; lineB: ConstraintGeomRef }
  // point_on_circle 은 circle/arc/ellipse 모두 다룸 — solver 가 target type 으로 분기.
  // field 명은 historical 이유로 "circle" 유지 (rename 시 영향 광범).
  | { type: "point_on_circle"; id: string; point: ConstraintPointRef; circle: ConstraintGeomRef }
  | { type: "radius"; id: string; circle: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "diameter"; id: string; circle: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "equal_radius"; id: string; circleA: ConstraintGeomRef; circleB: ConstraintGeomRef }
  | { type: "line_length"; id: string; line: ConstraintGeomRef; value: number } & DimensionRefFlag
  | {
      type: "angle"; id: string;
      lineA: ConstraintGeomRef; lineB: ConstraintGeomRef;
      value: number;
      // c.value 가 사잇각인지 보각인지 표시 (problem-definition 의 zone 패턴).
      // - undefined / true: 사잇각 (default). enforce / 라벨 / panel 모두 c.value 그대로.
      // - false: 보각. enforce = (180 - c.value) = 자연 사잇각. 라벨 / panel 은 c.value (보각) 표시.
      // 라벨이 보각 영역에 있을 때 line 회전 없이 보각 표시 + 자연 사잇각 enforce.
      isAcute?: boolean;
    } & DimensionRefFlag
  | { type: "line_angle"; id: string; line: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "point_line_distance"; id: string; point: ConstraintPointRef; line: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "line_line_distance"; id: string; lineA: ConstraintGeomRef; lineB: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "point_circle_distance"; id: string; point: ConstraintPointRef; circle: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "line_circle_distance"; id: string; line: ConstraintGeomRef; circle: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "circle_circle_distance"; id: string; circleA: ConstraintGeomRef; circleB: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "arc_length"; id: string; arc: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "ellipse_major_radius"; id: string; ellipse: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "ellipse_minor_radius"; id: string; ellipse: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "curve_length"; id: string; curve: ConstraintGeomRef; value: number } & DimensionRefFlag
  | { type: "symmetric"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef; axis: ConstraintGeomRef }
  | { type: "symmetric_point"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef; center: ConstraintPointRef }
  | { type: "horizontal_distance"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef; value: number; sign: 1 | -1 } & DimensionRefFlag
  | { type: "vertical_distance"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef; value: number; sign: 1 | -1 } & DimensionRefFlag
  | { type: "equidistant"; id: string; pointA: ConstraintPointRef; pointB: ConstraintPointRef; center: ConstraintPointRef }
  | { type: "fix_together"; id: string; elements: ConstraintGeomRef[]; label?: string };

/** Dimension 구속이 참조 전용(driven)인지 확인 */
export function isDrivenDimension(c: SketchConstraint): boolean {
  return "isReference" in c && c.isReference === true;
}

/** 치수 구속(dimensional) 타입 집합 — 나머지는 기하 구속(geometric)으로 분류 */
const DIMENSIONAL_TYPES: ReadonlySet<SketchConstraint["type"]> = new Set<SketchConstraint["type"]>([
  "distance",
  "horizontal_distance",
  "vertical_distance",
  "line_length",
  "radius",
  "diameter",
  "angle",
  "line_angle",
  "point_line_distance",
  "line_line_distance",
  "point_circle_distance",
  "line_circle_distance",
  "circle_circle_distance",
  "arc_length",
  "ellipse_major_radius",
  "ellipse_minor_radius",
  "curve_length",
]);

/** SketchConstraint 중 dimension 멤버 (`value: number` + `labelPos / labelOffset` 등 보유). */
export type DimensionConstraint = Extract<SketchConstraint, { value: number }>;

/** 구속이 치수 구속인지 판정 (driven dimension 포함) — type predicate. */
export function isDimensionalConstraint(
  c: SketchConstraint,
): c is DimensionConstraint {
  return DIMENSIONAL_TYPES.has(c.type);
}

// 솔버 결과 상태
export type SolveStatus = "ok" | "fully-constrained" | "over-constrained" | "under-constrained" | "error";

// 요소별 구속 상태 (CATIA V5 스타일 개별 색상 표시용)
export type ElementConstraintStatus = "under-constrained" | "fully-constrained" | "over-constrained";
