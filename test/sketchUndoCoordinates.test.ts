import "./helpers/assetStub";

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

test("이력 엔트리에는 실행 전후로 바뀐 기하만 남긴다", async () => {
  // 리뷰 반영 — 엔트리마다 스케치 전체를 두 벌 복제해 두어, 큰 스케치에서는 명령 하나마다 기하 수만큼 메모리가 늘었다
  const { store, history } = await createSketch();
  for (let i = 0; i < 20; i++) store.geometries.set(`F${i}`, line(`F${i}`, i, 100, i + 1, 120));
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new AddConstraintCommand({ type: "horizontal", id: "h", line: { geomId: "L" } }));

  // 내부 스택을 들여다본다 — 수평 구속 엔트리에는 솔버가 옮긴 L 만 있어야 한다
  type Entry = { before?: Map<string, unknown>; after?: Map<string, unknown> };
  const stack = (history as unknown as { _stack: Entry[] })._stack;
  const last = stack[stack.length - 1];
  assert.deepEqual([...(last.before?.keys() ?? [])], ["L"]);
  assert.deepEqual([...(last.after?.keys() ?? [])], ["L"]);
  const add = stack[stack.length - 2];
  assert.deepEqual([...(add.before?.keys() ?? [])], []);
  assert.deepEqual([...(add.after?.keys() ?? [])], ["L"]);

  // 되돌리기 결과는 그대로
  history.undo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });
  history.undo();
  history.redo();
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 5 });
  history.redo();
  const g = round(lineOf(store, "L"));
  assert.equal(g.y2, g.y1);
});
