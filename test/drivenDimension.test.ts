import assert from "node:assert/strict";
import { test } from "node:test";

import { addDrivenDimension } from "src/features/setup/sketch/constraints/drivenDimension";
import type { SketchConstraint } from "src/features/setup/sketch/constraints/SketchConstraint.type";

test("과구속 치수를 참조 치수로 만들면, 직전에 배치한 다른 치수가 아니라 새 참조 치수가 선택된다", () => {
  // 고치기 전에는 직전에 배치한 D1 이 선택된 채 값 패널이 열려, OK 하면 dimensionConfirm 이 선택된 D1 을
  // 패널 값(D2 의 25)으로 다시 만들어 A–B 가 끌려갔다. 값 패널·Delete 는 selectedConstraintId 를 대상으로 읽는다.
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

  addDrivenDimension(store, d2);

  assert.deepEqual(applied, [{ ...d2, isReference: true }]);
  assert.equal(store.selectedConstraintId, "D2");
});
