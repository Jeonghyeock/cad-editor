import * as THREE from "three";

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  PadPocketOperation,
  SerializedGeometry,
  SerializedSketch,
} from "src/features/setup/Setup.type";

// 애드온이 없는 기본 설치 — Pad/Pocket 은 Three.js 폴백(three-bvh-csg)으로 만든다.
(globalThis as Record<string, unknown>).window = {
  electron: { ipcRenderer: { invoke: async () => { throw new Error("native addon 없음"); } } },
};

const XY_PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
};
const disk: SerializedGeometry = { type: "circle", id: "disk", cx: 5, cy: 5, r: 5 };
const hole: SerializedGeometry = { type: "circle", id: "hole", cx: 5, cy: 5, r: 2 };
const sketches: Record<string, SerializedSketch> = {
  disk: { plane: XY_PLANE, geometries: [disk] },
  hole: { plane: XY_PLANE, geometries: [hole] },
};
const geometriesOf = (key: string) => new Map(sketches[key].geometries!.map((g) => [g.id, g]));

const pad: PadPocketOperation = {
  id: "op1", type: "pad", sketchPlaneKey: "disk", profileIds: [], depth: 10, direction: "normal",
};
const pocket: PadPocketOperation = {
  id: "op2", type: "pocket", sketchPlaneKey: "hole", profileIds: [], depth: 10, direction: "normal",
  targetOperationId: "op1",
};

async function padThenPocket() {
  const { SolidOperationManager } = await import("src/features/setup/rendering/SolidOperationManager");
  const manager = new SolidOperationManager(new THREE.Scene(), (key) => sketches[key] ?? null);
  await manager.addExtrudedSolid(pad, geometriesOf("disk"));
  await manager.addExtrudedSolid(pocket, geometriesOf("hole"));
  const visible = (id: string) => manager.extrudedSolids.get(id)?.visible;
  assert.equal(visible("op1"), false, "Pocket 이 원본 Pad 를 숨긴다");
  assert.equal(visible("op2"), true);
  return { manager, visible };
}

test("스케치를 열었다 닫아도 Pocket 에 소비된 원본 솔리드는 숨긴 채로 둔다", async () => {
  // 고치기 전에는 clearSketchPlane → setExtrudedSolidsVisible(true) 가 op1 까지 다시 보여 구멍을 메웠다
  const { manager, visible } = await padThenPocket();
  manager.setExtrudedSolidsVisible(false); // setupSketchPlane
  manager.setExtrudedSolidsVisible(true); // clearSketchPlane
  assert.equal(visible("op1"), false);
  assert.equal(visible("op2"), true);
});

test("operations·hiddenOperations 동기화가 보이게 해도 소비된 원본은 숨긴 채로 둔다", async () => {
  // setup/index.tsx 의 [operations, hiddenOperations] effect 가 숨기지 않은 op 마다 이렇게 부른다
  const { manager, visible } = await padThenPocket();
  manager.setExtrudedSolidVisible("op1", true);
  manager.setExtrudedSolidVisible("op2", true);
  assert.equal(visible("op1"), false);
  assert.equal(visible("op2"), true);
});

test("Pocket 을 undo 하면 원본 솔리드가 다시 보인다", async () => {
  // CreatePadCommand.undo 의 순서: 결과 솔리드 제거 → 원본 표시
  const { manager, visible } = await padThenPocket();
  manager.removeExtrudedSolid("op2");
  manager.restoreSourceVisibility("op1");
  assert.equal(visible("op1"), true);
  manager.setExtrudedSolidsVisible(false);
  manager.setExtrudedSolidsVisible(true);
  assert.equal(visible("op1"), true);
});

test("Pocket 을 지우면 operations 동기화가 원본 솔리드를 다시 보인다", async () => {
  // DeletePadCommand 는 결과 솔리드만 지우고, 원본 표시는 operations 가 바뀌어 도는 effect 가 맡는다
  const { manager, visible } = await padThenPocket();
  manager.removeExtrudedSolid("op2");
  manager.setExtrudedSolidVisible("op1", true);
  assert.equal(visible("op1"), true);
});
