import assert from "node:assert/strict";
import { test } from "node:test";

import { addDrivenDimension } from "src/features/setup/sketch/constraints/drivenDimension";
import type { SketchConstraint } from "src/features/setup/sketch/constraints/SketchConstraint.type";

// D1 이 선택돼 있고 (값 패널이 열려 있을 수 있는) 상태에서 과구속인 D2 를 참조 치수로 추가한다
function addD2() {
  const applied: SketchConstraint[] = [];
  const store = {
    applyConstraint: (c: SketchConstraint) => {
      applied.push(c);
    },
    selectedConstraintId: "D1" as string | null,
  };
  const d2: SketchConstraint = {
    type: "distance", id: "D2",
    pointA: { geomId: "L1", vertexIndex: 0 }, pointB: { geomId: "L1", vertexIndex: 1 }, value: 25,
  };
  let panelClosed = 0;
  addDrivenDimension(store, d2, () => {
    panelClosed++;
  });
  return { applied, store, d2, panelClosed };
}

test("과구속 치수를 참조 치수로 만들면, 직전에 배치한 다른 치수가 아니라 새 참조 치수가 선택된다", () => {
  // 고치기 전에는 직전에 배치한 D1 이 선택된 채 값 패널이 열려, OK 하면 dimensionConfirm 이 선택된 D1 을
  // 패널 값(D2 의 25)으로 다시 만들어 A–B 가 끌려갔다. 값 패널·Delete 는 selectedConstraintId 를 대상으로 읽는다.
  const { applied, store, d2 } = addD2();

  assert.deepEqual(applied, [{ ...d2, isReference: true }]);
  assert.equal(store.selectedConstraintId, "D2");
});

test("선택을 새 참조 치수로 옮길 때 이미 열린 값 패널을 닫는다", () => {
  // 고치기 전(이 PR 의 앞 커밋)에는 D1 을 더블클릭해 열어 둔 값 패널이 그대로 남아, 그 OK 가 선택이 옮겨진
  // 참조 치수 D2 를 D1 의 패널 값으로 다시 만들었다
  assert.equal(addD2().panelClosed, 1);
});
