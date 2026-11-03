import "./helpers/assetStub";

import assert from "node:assert/strict";
import { test } from "node:test";

import { AddConstraintCommand } from "src/features/setup/sketch/commands/AddConstraintCommand";
import { AddGeometryCommand } from "src/features/setup/sketch/commands/AddGeometryCommand";

import { createSketch, line, lineOf, round } from "./helpers/sketch";

// 2026-10-28 코드리뷰 cad-editor#33 — tryApplyConstraint 가 거부한 구속이 redo 자리에 남고, 기존 redo 이력은 잘려 나갔다.

test("상충해 거부된 구속은 이력에 남지 않고, 그 전에 undo 한 구속을 redo 할 수 있다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new AddConstraintCommand({ type: "line_length", id: "len10", line: { geomId: "L" }, value: 10 }));
  store.execute(new AddConstraintCommand({ type: "horizontal", id: "X", line: { geomId: "L" } }));
  history.undo();
  const beforeTry = round(lineOf(store, "L"));

  const ok = store.tryApplyConstraint({ type: "line_length", id: "len20", line: { geomId: "L" }, value: 20 });
  assert.equal(ok, false);
  assert.equal(store.constraintStore?.constraints.has("len20"), false);
  assert.deepEqual(round(lineOf(store, "L")), beforeTry);

  // 고치기 전에는 X 의 redo 가 사라지고, 거부된 len20 이 redo 자리에 남아 검증 없이 들어갔다
  assert.equal(history.canRedo, true);
  history.redo();
  const constraints = store.constraintStore?.constraints;
  assert.equal(constraints?.has("X"), true);
  assert.equal(constraints?.has("len20"), false);
  assert.notEqual(store.solveStatus, "over-constrained");
  assert.equal(history.canRedo, false);
});

test("받아들여진 구속은 이력 한 칸이 되어 undo 로 빠진다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));

  assert.equal(store.tryApplyConstraint({ type: "horizontal", id: "h", line: { geomId: "L" } }), true);
  assert.equal(store.constraintStore?.constraints.has("h"), true);

  history.undo();
  assert.equal(store.constraintStore?.constraints.has("h"), false);
  assert.equal(store.geometries.has("L"), true);
});

test("이력 관리자가 연결되기 전에도 맞는 구속은 적용해 true, 상충 구속은 되돌려 false 를 돌려준다", async () => {
  // 리뷰 반영 — 이력이 없을 때 tryExecute 가 늘 false 를 돌려 정상 치수도 과구속 안내로 갔다
  const { store } = await createSketch();
  store.globalHistory = null;
  store.geometries.set("L", line("L", 0, 0, 10, 5));

  assert.equal(store.tryApplyConstraint({ type: "line_length", id: "len10", line: { geomId: "L" }, value: 10 }), true);
  assert.equal(store.constraintStore?.constraints.has("len10"), true);
  const g = lineOf(store, "L");
  assert.ok(Math.abs(Math.hypot(g.x2 - g.x1, g.y2 - g.y1) - 10) < 1e-6);

  const before = round(lineOf(store, "L"));
  assert.equal(store.tryApplyConstraint({ type: "line_length", id: "len20", line: { geomId: "L" }, value: 20 }), false);
  assert.equal(store.constraintStore?.constraints.has("len20"), false);
  assert.deepEqual(round(lineOf(store, "L")), before);
});
