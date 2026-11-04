import "./support/browserStubs";

import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchCommands } from "src/features/setup/Setup.type";
import { AddConstraintCommand } from "src/features/setup/sketch/commands/AddConstraintCommand";
import { AddGeometryCommand } from "src/features/setup/sketch/commands/AddGeometryCommand";
import type { SketchConstraint } from "src/features/setup/sketch/constraints/SketchConstraint.type";
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

type Prompt = (constraint: SketchConstraint, callback: (asReference: boolean) => void) => void;

// 훅이 값 패널을 열고 닫으려고 부른 setDimensionMode 값 (null = 닫기)
const dimensionModes: unknown[] = [];

async function dimensionConfirm(store: SketchGeometryStore, constraintId: string, value: number, onDrivenDimensionPrompt?: Prompt) {
  const { useSketchRefCallbacks } = await import("src/features/setup/hooks/useSketchRefCallbacks");
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  useSketchRefCallbacks({
    onDrivenDimensionPrompt,
    geometryStoreRef: { current: store },
    activeDrawToolRef: { current: null },
    sceneRef: { current: null },
    drawToolMap: new Map(),
    models: [],
    deletedBodies: new Map(),
    hiddenBodies: new Map(),
    setDimensionMode: (mode) => dimensionModes.push(mode),
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

// 리뷰 반영 — 상충하는 값으로 편집하면 되돌리기만 하고 아무 안내 없이 끝났다. 새 치수 배치처럼 과구속 안내를 띄운다.

async function fixedLineWithLength() {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 0)));
  store.execute(new AddConstraintCommand({ type: "fix", id: "f1", point: { geomId: "L", vertexIndex: 0 }, x: 0, y: 0 }));
  store.execute(new AddConstraintCommand({ type: "fix", id: "f2", point: { geomId: "L", vertexIndex: 1 }, x: 10, y: 0 }));
  store.execute(new AddConstraintCommand({ type: "line_length", id: "d", line: { geomId: "L" }, value: 10 }));
  return { store, history };
}

test("상충하는 치수 값이면 과구속 안내를 띄우고, 참조 치수로 하겠다면 그 치수를 참조로 바꾼다(이력 한 칸)", async () => {
  const { store, history } = await fixedLineWithLength();
  const prompts: { constraint: SketchConstraint; callback: (asReference: boolean) => void }[] = [];
  await dimensionConfirm(store, "d", 20, (constraint, callback) => prompts.push({ constraint, callback }));

  // 고치기 전에는 안내 없이 조용히 되돌렸다
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].constraint.id, "d");
  assert.equal(lengthOf(store), 10);

  prompts[0].callback(true);
  const d = store.constraintStore?.constraints.get("d");
  assert.equal(d && "isReference" in d && d.isReference, true);
  assert.equal(store.solveStatus, "fully-constrained");
  assert.deepEqual(round(lineOf(store, "L")), { x1: 0, y1: 0, x2: 10, y2: 0 });

  history.undo();
  const restored = store.constraintStore?.constraints.get("d");
  assert.equal(restored && "isReference" in restored && restored.isReference, false);
  assert.equal(lengthOf(store), 10);
});

test("과구속 안내에서 취소하면 이전 값 그대로 둔다", async () => {
  const { store } = await fixedLineWithLength();
  await dimensionConfirm(store, "d", 20, (_constraint, callback) => callback(false));
  const d = store.constraintStore?.constraints.get("d");
  assert.equal(lengthOf(store), 10);
  assert.equal(d && "isReference" in d && d.isReference, false);
});

// 리뷰 반영(2차) — 과구속 안내의 콜백이 편집 당시의 치수·store 를 붙든 채, 답할 때 상황을 확인하지 않았다.

test("안내에 답하기 전에 다른 스케치로 바뀌었으면 참조 치수로 바꾸지 않는다", async () => {
  const { store, history } = await fixedLineWithLength();
  const prompts: ((asReference: boolean) => void)[] = [];
  await dimensionConfirm(store, "d", 20, (_constraint, callback) => prompts.push(callback));
  history.setActiveSketch("YZ");

  prompts[0](true);
  const d = store.constraintStore?.constraints.get("d");
  assert.equal(d && "isReference" in d && d.isReference, false);
});

test("안내에 답하기 전에 그 치수가 지워졌으면 아무것도 하지 않는다", async () => {
  const { store } = await fixedLineWithLength();
  const prompts: ((asReference: boolean) => void)[] = [];
  await dimensionConfirm(store, "d", 20, (_constraint, callback) => prompts.push(callback));
  store.removeConstraintById("d");

  prompts[0](true);
  // 고치기 전에는 지워진 치수가 참조 치수로 다시 들어왔다
  assert.equal(store.constraintStore?.constraints.has("d"), false);
});

test("편집 치수를 참조 치수로 바꾸면 새 치수 배치처럼 그 치수를 선택하고 값 패널을 닫는다", async () => {
  // 리뷰 반영(2차) — 편집 경로가 { ...updated, isReference: true } 를 따로 만들어, addDrivenDimension 을 쓰는 새 치수
  // 경로와 선택·패널 닫기가 달랐다
  const { store, history } = await fixedLineWithLength();
  const prompts: ((asReference: boolean) => void)[] = [];
  await dimensionConfirm(store, "d", 20, (_constraint, callback) => prompts.push(callback));
  dimensionModes.length = 0;

  prompts[0](true);
  assert.equal(store.selectedConstraintId, "d");
  assert.deepEqual(dimensionModes, [null]);
  // undo 한 번에 원래(구동) 치수로 돌아오는 것은 그대로
  history.undo();
  const d = store.constraintStore?.constraints.get("d");
  assert.equal(d && "isReference" in d && d.isReference, false);
});
