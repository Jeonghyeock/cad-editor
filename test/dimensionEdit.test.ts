import "./helpers/assetStub";

import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchCommands } from "src/features/setup/Setup.type";
import { AddConstraintCommand } from "src/features/setup/sketch/commands/AddConstraintCommand";
import { AddGeometryCommand } from "src/features/setup/sketch/commands/AddGeometryCommand";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

import { createSketch, line, lineOf, round } from "./helpers/sketch";

// 2026-10-28 코드리뷰 cad-editor#40 — 치수 값 편집이 이력에 Remove/Add 두 칸으로 쌓여 Ctrl+Z 한 번에 치수가 사라졌고,
// 상충하는 값도 되돌리지 않고 적용됐다.

// useSketchRefCallbacks 를 React 없이 부른다(closeWindow.test.ts 와 같은 방식). useEffect 는 바로 실행하고,
// 훅이 sketchCommandsAtom 에 넣는 콜백 묶음을 받아 둔다.
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};
let commands: SketchCommands | null = null;
stub("react", {
  ...React,
  useEffect: (fn: () => void) => fn(),
  useRef: <T,>(current: T) => ({ current }),
});
stub("jotai", { ...jotai, useSetAtom: () => (value: SketchCommands) => (commands = value) });
// 3D 엣지 투영용 모듈은 window·wasm 을 읽어 node 에서 불러올 수 없다. 치수 편집과 관계없으므로 비워 둔다.
stub("src/features/setup/step/BRepEdgeExtractorNative", {});
stub("src/features/setup/step/OcctWasmManager", {});

async function dimensionConfirm(store: SketchGeometryStore, constraintId: string, value: number) {
  const { useSketchRefCallbacks } = await import("src/features/setup/hooks/useSketchRefCallbacks");
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  useSketchRefCallbacks({
    geometryStoreRef: { current: store },
    activeDrawToolRef: { current: null },
    sceneRef: { current: null },
    drawToolMap: new Map(),
    models: [],
    deletedBodies: new Map(),
    hiddenBodies: new Map(),
    setDimensionMode: () => {},
    setFilletMode: () => {},
    setFilletRadius: () => {},
    setChamferMode: () => {},
    setChamferDistance: () => {},
    setChamferDistance2: () => {},
    setOffsetMode: () => {},
    setOffsetDistance: () => {},
    filletRadius: 0,
    chamferDistance: 0,
    chamferDistance2: 0,
    offsetDistance: 0,
  });
  // 치수를 더블클릭하면 그 구속이 선택되고 값 패널이 열린다. OK 를 누르면 dimensionConfirm 이 불린다.
  store.selectedConstraintId = constraintId;
  commands?.dimensionConfirm("line_length", value);
}

const lengthOf = (store: SketchGeometryStore) => {
  const c = store.constraintStore?.constraints.get("d");
  return c && "value" in c ? c.value : undefined;
};

test("치수 값을 바꾼 뒤 Ctrl+Z 한 번이면 이전 값과 선 위치로 돌아온다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 0)));
  store.execute(new AddConstraintCommand({ type: "line_length", id: "d", line: { geomId: "L" }, value: 10 }));

  await dimensionConfirm(store, "d", 20);
  assert.equal(lengthOf(store), 20);
  const g = lineOf(store, "L");
  assert.ok(Math.abs(Math.hypot(g.x2 - g.x1, g.y2 - g.y1) - 20) < 1e-6);

  // 고치기 전에는 첫 undo 가 새 치수만 지워 치수가 사라지고 선은 20 에 남았다
  history.undo();
  assert.equal(lengthOf(store), 10);
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 0 });

  history.redo();
  assert.equal(lengthOf(store), 20);
});

test("상충하는 치수 값은 적용하지 않고 이전 값과 이력을 그대로 둔다", async () => {
  // 양 끝점을 고정한 선 — 길이 치수 10 은 맞지만 20 은 만족할 수 없다
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 0)));
  store.execute(new AddConstraintCommand({ type: "fix", id: "f1", point: { geomId: "L", vertexIndex: 0 }, x: 0, y: 0 }));
  store.execute(new AddConstraintCommand({ type: "fix", id: "f2", point: { geomId: "L", vertexIndex: 1 }, x: 10, y: 0 }));
  store.execute(new AddConstraintCommand({ type: "line_length", id: "d", line: { geomId: "L" }, value: 10 }));
  assert.equal(store.solveStatus, "fully-constrained");

  await dimensionConfirm(store, "d", 20);
  assert.equal(lengthOf(store), 10);
  assert.equal(store.solveStatus, "fully-constrained");
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 0 });

  // 이력에도 남지 않았다 — undo 하면 치수를 건 작업이 빠진다
  history.undo();
  assert.equal(store.constraintStore?.constraints.has("d"), false);
});
