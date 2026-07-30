// 스케치 기하 ↔ 구속 의존성 그래프 (CATIA V5 스타일 Parent/Child 하이라이트)
// 선택된 기하/구속으로부터 직접 연결된 이웃(depth 1)을 탐색하여 강조 대상 Set 반환
// Why: 복잡한 스케치에서 특정 기하가 어떤 구속에 묶여 있는지, 또는 구속이 어느 기하를 참조하는지
//       즉시 시각적으로 파악하기 위함. CATIA는 선택 시 연관 구속/기하를 자동 강조한다.

import type { SerializedGeometry } from "../Setup.type";
import { getConstraintRefs } from "../utils/geometryUtils";

import type { SketchConstraint } from "./constraints/SketchConstraint.type";
import type { SketchConstraintStore } from "./constraints/SketchConstraintStore";

export type DependencyHighlight = {
  geomIds: Set<string>;         // 하이라이트할 기하 ID
  constraintIds: Set<string>;   // 하이라이트할 구속 ID
};

const EMPTY: DependencyHighlight = { geomIds: new Set(), constraintIds: new Set() };

/**
 * 선택된 구속에 대한 depth=1 의존성 하이라이트 계산.
 * - 선택된 구속이 참조하는 기하 → COLOR_DEPENDENCY 로 강조
 * - point ref (pointA/B, point, center) 가 vertex source 면 parent geometry (line/polygon) 까지
 *   highlight 하면 misleading (사용자가 coincident 클릭 시 line 2 개가 선택된 것처럼 보임).
 *   → pointRef 는 type === "point" 인 geometry 만 highlight, vertex source 는 제외.
 */
export function computeDependencyHighlight(
  selectedGeomIds: string[],
  selectedConstraintId: string | null,
  constraintStore: SketchConstraintStore | null,
  geometries?: Map<string, SerializedGeometry>,
): DependencyHighlight {
  if (!constraintStore) return EMPTY;
  if (!selectedConstraintId) return EMPTY;

  const selectedGeomSet = new Set(selectedGeomIds);
  const neighborGeoms = new Set<string>();
  const neighborConstraints = new Set<string>();

  const c: SketchConstraint | undefined = constraintStore.constraints.get(selectedConstraintId);
  if (c) {
    const { pointRefs, geomRefs } = getConstraintRefs(c);
    // geomRefs: 항상 highlight (line / circle / arc / ellipse / curve / polygon)
    for (const g of geomRefs) {
      if (!selectedGeomSet.has(g)) neighborGeoms.add(g);
    }
    // pointRefs: type === "point" 인 geometry 만 highlight. vertex source 는 parent geometry
    // (line/polygon) 가 아니므로 제외 — 두 점만의 관계라는 의미 보존.
    for (const pr of pointRefs) {
      const g = geometries?.get(pr.geomId);
      if (g?.type === "point" && !selectedGeomSet.has(pr.geomId)) {
        neighborGeoms.add(pr.geomId);
      }
    }
  }

  return { geomIds: neighborGeoms, constraintIds: neighborConstraints };
}
