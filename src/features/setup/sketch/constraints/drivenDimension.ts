// 과구속 치수를 참조(driven) 치수로 추가 (SetupCanvas 의 driven 프롬프트에서 사용)

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchConstraint } from "./SketchConstraint.type";

/**
 * 과구속 치수를 참조(driven) 치수로 추가하고 선택한다 (솔버 무시) — 일반 배치 (onPlaced) 처럼 새 치수만 선택.
 * 값 패널의 OK (dimensionConfirm) 와 Delete 키는 selectedConstraintId 를 대상으로 읽으므로, 직전에 배치해
 * 선택돼 있던 다른 치수가 대상으로 남으면 그 치수가 패널 값으로 다시 만들어진다.
 * 같은 이유로 이미 열려 있던 값 패널 (예: D1 을 더블클릭해 연 것) 은 닫는다 — 열린 채면 그 OK 가 선택이
 * 옮겨진 참조 치수를 다른 치수의 값으로 다시 만든다.
 */
export function addDrivenDimension(
  store: Pick<SketchGeometryStore, "applyConstraint" | "selectedConstraintId">,
  constraint: SketchConstraint,
  closeValuePanel: () => void,
): void {
  const refConstraint = { ...constraint, isReference: true } as typeof constraint & { isReference: true };
  store.applyConstraint(refConstraint);
  store.selectedConstraintId = refConstraint.id;
  closeValuePanel();
}
