import "./helpers/assetStub";

import { createStore } from "jotai";

import assert from "node:assert/strict";
import { test } from "node:test";

import { enterSketchModeAtom, exitSketchModeAtom, setupGlobalHistoryAtom } from "src/features/setup/Setup.store";
import { AddGeometryCommand } from "src/features/setup/sketch/commands/AddGeometryCommand";
import { DragSnapshotCommand } from "src/features/setup/sketch/commands/DragSnapshotCommand";
import { RemoveGeometryCommand } from "src/features/setup/sketch/commands/RemoveGeometryCommand";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

import { fileIdAtom } from "src/shared/stores/File.store";

import { createSketch, line, lineOf } from "./helpers/sketch";

// 2026-10-28 코드리뷰 cad-editor#18·#23 — 스케치 기하 undo/redo 가 명령의 소속 스케치를 기록하지 않아,
// 스케치를 닫고 다른 스케치를 연 뒤 Ctrl+Z/Ctrl+Y 하면 앞 스케치의 명령이 지금 스케치에 적용됐다.

// SetupCanvas 의 Close Sketch 와 스케치 진입(restoreSketch)을 흉내 낸다. 스케치 기하는 닫을 때 bake 되고 store 는 비워진다.
type Saved = ReturnType<SketchGeometryStore["serialize"]>;
function closeSketch(store: SketchGeometryStore): Saved {
  const saved = store.serialize();
  store.clear();
  store.constraintStore?.clear();
  return saved;
}
function openSketch(store: SketchGeometryStore, saved: Saved = []) {
  if (saved.length > 0) store.deserialize(saved);
  store.injectReferenceGeometry();
}

test("XY 에서 지운 선이, 닫고 YZ 를 연 뒤의 Ctrl+Z 로 YZ 에 들어오지 않는다", async () => {
  const { store, history } = await createSketch();
  history.setActiveSketch("XY");
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new RemoveGeometryCommand([store.geometries.get("L")!]));
  closeSketch(store);
  history.setActiveSketch(null);

  history.setActiveSketch("YZ");
  openSketch(store);
  const undone = history.undo();
  // 고치기 전에는 RemoveGeometryCommand.undo 가 XY 의 선을 YZ store 에 다시 넣었다
  assert.equal(store.geometries.has("L"), false);
  assert.equal(undone, null);
});

test("XY 에서 그린 선을 닫은 뒤 Ctrl+Z → 새 스케치 Ctrl+Y 해도 새 스케치에 들어오지 않는다", async () => {
  const { store, history } = await createSketch();
  history.setActiveSketch("XY");
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  closeSketch(store);
  history.setActiveSketch(null);

  // 3D 모드의 Ctrl+Z 는 XY 엔트리 앞에서 멈춘다
  const undone = history.undo();

  history.setActiveSketch("YZ");
  openSketch(store);
  const redone = history.redo();
  // 고치기 전에는 3D 의 Ctrl+Z 가 인덱스만 내리고, YZ 의 Ctrl+Y 가 XY 좌표의 선을 YZ 에 넣었다
  assert.equal(store.geometries.has("L"), false);
  assert.equal(undone, null);
  assert.equal(redone, null);
  assert.equal(history.undo(), null);
});

test("다른 스케치의 드래그 엔트리를 만나도 지금 스케치의 기하가 지워지지 않는다", async () => {
  const { store, history } = await createSketch();
  history.setActiveSketch("XY");
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  const clone = () => new Map([...store.geometries].map(([id, g]) => [id, structuredClone(g)]));
  const before = clone();
  store.geometries.set("L", line("L", 0, 0, 20, 8));
  store.pushSnapshot(new DragSnapshotCommand(before, clone()));
  closeSketch(store);
  history.setActiveSketch(null);

  history.setActiveSketch("YZ");
  openSketch(store);
  store.execute(new AddGeometryCommand(line("M", 1, 1, 2, 2)));

  assert.equal(history.undo(), "geometry");
  assert.equal(store.geometries.has("M"), false);
  const refIds = [...store.geometries.keys()];
  const undone = history.undo();
  // 고치기 전에는 DragSnapshotCommand.undo 가 store 를 비우고 XY 의 드래그 전 기하로 채웠다
  assert.equal(store.geometries.has("L"), false);
  assert.deepEqual([...store.geometries.keys()], refIds); // 원점·축 참조 기하는 그대로
  assert.equal(undone, null);
  assert.equal(history.redo(), "geometry");
  assert.equal(store.geometries.has("M"), true);
});

test("XY 를 다시 열면 멈췄던 자리부터 이어서 undo/redo 한다", async () => {
  const { store, history } = await createSketch();
  history.setActiveSketch("XY");
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  const saved = closeSketch(store);
  history.setActiveSketch(null);
  assert.equal(history.undo(), null);

  history.setActiveSketch("XY");
  openSketch(store, saved);
  assert.equal(history.undo(), "geometry");
  assert.equal(store.geometries.has("L"), false);
  assert.equal(history.redo(), "geometry");
  assert.deepEqual(lineOf(store, "L"), { x1: 0, y1: 0, x2: 10, y2: 5 });
});

test("스케치 진입·종료 atom 이 파일의 이력에 지금 열린 스케치를 알린다", async () => {
  const jotaiStore = createStore();
  jotaiStore.set(fileIdAtom, "a");
  const { store, history } = await createSketch(jotaiStore.get(setupGlobalHistoryAtom));

  jotaiStore.set(enterSketchModeAtom, { planeKey: "XY", planeName: "Sketch 1" });
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  const saved = closeSketch(store);
  jotaiStore.set(exitSketchModeAtom);
  assert.equal(history.undo(), null);

  jotaiStore.set(enterSketchModeAtom, { planeKey: "YZ", planeName: "Sketch 2" });
  openSketch(store);
  assert.equal(history.undo(), null);
  closeSketch(store);
  jotaiStore.set(exitSketchModeAtom);

  jotaiStore.set(enterSketchModeAtom, { planeKey: "XY", planeName: "Sketch 1" });
  openSketch(store, saved);
  assert.equal(history.undo(), "geometry");
  assert.equal(store.geometries.has("L"), false);
});
