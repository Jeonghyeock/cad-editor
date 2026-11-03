// 스케치를 닫거나 새로 열 때 라이브 기하·구속 저장소를 정리 (SetupCanvas 에서 사용)
// 두 저장소는 스케치 사이에 공유되는 인스턴스라, 비우지 않으면 이전 스케치의 구속·shape 가
// 다음 스케치의 저장 데이터·.cad·SpecTree 목록에 섞여 들어간다.

import type { SketchConstraintStore } from "./constraints/SketchConstraintStore";
import type { SketchGeometryStore } from "./SketchGeometryStore";

/**
 * 닫은 스케치의 라이브 상태를 비운다 — 호출 전에 baked sketch 로 직렬화해 두어야 한다.
 * line geometry / constraint 는 baked sketch 가 SSOT 이므로 clear (다시 들어갈 때 restoreSketch 가
 * 저장 데이터에서 읽어 복원). shape 만 기존대로 보존.
 */
export function clearClosedSketch(geoStore: SketchGeometryStore, constraintStore: SketchConstraintStore): void {
  const preservedShapes = geoStore.shapes.slice();
  geoStore.clear();
  geoStore.shapes = preservedShapes;
  constraintStore.clear();
  geoStore.requestRender();
}

/**
 * 저장된 스케치가 없는 평면으로 들어간다 — 빈 스케치를 restoreSketch 하는 것과 같다.
 * 닫을 때 보존한 shape 까지 비워야, 아무것도 그리지 않고 닫았을 때 이전 스케치의 shape 가
 * 유령 면으로 bake 되지 않는다.
 */
export function startBlankSketch(geoStore: SketchGeometryStore, constraintStore: SketchConstraintStore): void {
  geoStore.clear();
  constraintStore.clear();
  // SetupCanvas 의 렌더 리스너는 두 버전이 바뀔 때만 SpecTree 기하·shape·구속 목록을 다시 만든다 —
  // clear() 는 버전을 올리지 않으므로, 올리지 않으면 이전 스케치의 shape 목록이 그대로 남는다.
  // injectReferenceGeometry 의 requestRender 보다 먼저 올린다.
  geoStore.markGeometryChanged();
  geoStore.markShapesChanged();
  geoStore.injectReferenceGeometry();
}
