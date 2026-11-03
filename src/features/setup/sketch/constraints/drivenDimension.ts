// 과구속 치수를 참조(driven) 치수로 추가 (SetupCanvas 의 driven 프롬프트에서 사용)

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { RemoveConstraintCommand } from "../commands/RemoveConstraintCommand";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchConstraint } from "./SketchConstraint.type";

/**
 * 과구속 치수를 참조(driven) 치수로 추가하고 선택한다 (솔버 무시) — 일반 배치 (onPlaced) 처럼 새 치수만 선택.
 * 값 패널의 OK (dimensionConfirm) 와 Delete 키는 selectedConstraintId 를 대상으로 읽으므로, 직전에 배치해
 * 선택돼 있던 다른 치수가 대상으로 남으면 그 치수가 패널 값으로 다시 만들어진다.
 * 같은 이유로 이미 열려 있던 값 패널 (예: D1 을 더블클릭해 연 것) 은 닫는다 — 열린 채면 그 OK 가 선택이
 * 옮겨진 참조 치수를 다른 치수의 값으로 다시 만든다.
 *
 * 이미 있는 치수를 참조로 바꾸는 경우(값 편집이 과구속, useSketchRefCallbacks 의 dimensionConfirm)도 같은 함수를
 * 쓴다 — 같은 id 로 덮어쓰면 undo 가 치수를 통째로 지우므로, 삭제·추가를 한 칸으로 묶어 undo 하면 원래 치수로 돌아오게.
 */
export function addDrivenDimension(
  store: Pick<SketchGeometryStore, "applyConstraint" | "selectedConstraintId"> &
    Partial<Pick<SketchGeometryStore, "execute" | "constraintStore">>,
  constraint: SketchConstraint,
  closeValuePanel: () => void,
): void {
  const refConstraint = { ...constraint, isReference: true } as typeof constraint & { isReference: true };
  const existing = store.constraintStore?.constraints.get(constraint.id);
  if (existing && store.execute) {
    store.execute(
      new BatchCommand([new RemoveConstraintCommand(existing), new AddConstraintCommand(refConstraint)]),
    );
  } else {
    store.applyConstraint(refConstraint);
  }
  store.selectedConstraintId = refConstraint.id;
  closeValuePanel();
}
