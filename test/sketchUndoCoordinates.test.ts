import "./support/browserStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { AddConstraintCommand } from "src/features/setup/sketch/commands/AddConstraintCommand";
import { AddGeometryCommand } from "src/features/setup/sketch/commands/AddGeometryCommand";
import { DragSnapshotCommand } from "src/features/setup/sketch/commands/DragSnapshotCommand";

import { createSketch, line, lineOf, round } from "./helpers/sketch";

// 2026-10-28 코드리뷰 cad-editor#11 — 솔버는 기하 좌표를 제자리에서 고치므로, 구속을 undo 해도 옮긴 좌표가 남았다.

test("기울어진 선에 건 수평 구속을 undo 하면 선이 원래 기울기로 돌아온다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new AddConstraintCommand({ type: "horizontal", id: "h", line: { geomId: "L" } }));
  assert.equal(round(lineOf(store, "L")).y2, round(lineOf(store, "L")).y1);

  history.undo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });
});

test("길이 치수를 undo 하면 선 길이가 치수를 걸기 전으로 돌아온다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 30, 40)));
  store.execute(new AddConstraintCommand({ type: "line_length", id: "d", line: { geomId: "L" }, value: 100 }));
  const g = lineOf(store, "L");
  assert.ok(Math.abs(Math.hypot(g.x2 - g.x1, g.y2 - g.y1) - 100) < 1e-6);

  history.undo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 30, y2: 40 });
});

test("선 추가 → 수평 → undo 두 번 → redo 하면 기울어진 선이 들어온다", async () => {
  // 고치기 전에는 AddGeometryCommand 가 들고 있던 객체를 솔버가 수평으로 고쳐 두어, redo 로 수평 선이 다시 들어왔다
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new AddConstraintCommand({ type: "horizontal", id: "h", line: { geomId: "L" } }));

  history.undo();
  history.undo();
  assert.equal(store.geometries.has("L"), false);

  history.redo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });

  history.redo();
  const g = round(lineOf(store, "L"));
  assert.equal(g.y2, g.y1);
});

test("드래그를 redo 하면, 그 사이 다른 솔브가 옮긴 좌표가 아니라 드래그 결과로 돌아온다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));

  // useDragController 처럼 드래그 전후를 복제해 push 한다(드래그는 이미 끝난 상태)
  const clone = () => new Map([...store.geometries].map(([id, g]) => [id, structuredClone(g)]));
  const before = clone();
  store.geometries.set("L", line("L", 0, 0, 20, 8));
  store.pushSnapshot(new DragSnapshotCommand(before, clone()));

  history.undo();
  history.redo();
  // redo 로 들어온 드래그 결과 객체를 이어지는 수평 구속의 솔브가 제자리에서 고친다
  store.execute(new AddConstraintCommand({ type: "horizontal", id: "h", line: { geomId: "L" } }));
  history.undo();
  history.undo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });

  history.redo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 20, y2: 8 });
});

test("스스로 전체 스냅샷을 가진 드래그 명령에는 이력 쪽 스냅샷을 만들지 않는다", async () => {
  // 리뷰 반영 — DragSnapshotCommand 는 드래그 전후 기하 전체를 들고 있는데, 이력이 한 벌 더 복제해 두고 redo 때 덮어썼다
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  const clone = () => new Map([...store.geometries].map(([id, g]) => [id, structuredClone(g)]));
  const before = clone();
  store.geometries.set("L", line("L", 0, 0, 20, 8));
  const cmd = new DragSnapshotCommand(before, clone());

  const original = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = ((value: unknown) => {
    clones++;
    return original(value);
  }) as typeof structuredClone;
  try {
    store.pushSnapshot(cmd);
  } finally {
    globalThis.structuredClone = original;
  }
  assert.equal(clones, 0);

  history.undo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });
  history.redo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 20, y2: 8 });
});

test("기록되지 않은 좌표 변경이 있어도 undo 는 그 엔트리의 실행 전 상태 그대로 돌아온다", async () => {
  // 리뷰 반영(2차) — 바뀐 기하만 남기는 diff 복원은, 기록되지 않은 좌표 변경(스케치 없이·이력 없이 실행, undo 중
  // cleanOrphanConstraints, 다시 열 때의 재솔브)이 끼면 그 기하를 건드리지 않아 존재한 적 없는 상태를 만들었다
  const { applyGeometryCommand } = await import("src/features/setup/core/GlobalHistoryManager");
  const { MoveGeometryCommand } = await import("src/features/setup/sketch/commands/MoveGeometryCommand");
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new AddGeometryCommand(line("M", 20, 0, 30, 0)));

  // 이력 없이 실행되는 경로(applyGeometryCommand)로 L 이 옮겨진다 — 기록되지 않음
  applyGeometryCommand(new MoveGeometryCommand(["L"], 5, 5), store, () => true);
  assert.deepEqual(round(lineOf(store, "L")), { x1: 5, y1: 5, x2: 15, y2: 10 });

  // M 추가를 undo 하면 그 엔트리를 실행하기 전 상태 — L 은 (0,0)-(10,5), M 없음 — 로 돌아와야 한다
  history.undo();
  assert.equal(store.geometries.has("M"), false);
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });
});
