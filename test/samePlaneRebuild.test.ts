import * as THREE from "three";

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  OperationTreeEntry,
  PadPocketOperation,
  RevolveOperation,
  SerializedGeometry,
  SerializedSketch,
} from "src/features/setup/Setup.type";

// 애드온이 없는 기본 설치 — native IPC 는 main 을 한 번 다녀온 뒤 실패하고, 솔리드는 Three.js 폴백으로 만든다.
// 왕복을 setTimeout 으로 흉내 낸다(지연이 0 이어도 같은 결과).
let ipcDelayMs = 3;
(globalThis as Record<string, unknown>).window = {
  electron: {
    ipcRenderer: {
      invoke: () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("native addon 없음")), ipcDelayMs)),
    },
  },
};

const XY_PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
};
const KEY = "0,0,0|0,0,1";

async function rebuild(geometries: SerializedGeometry[], target: OperationTreeEntry["operation"]) {
  const { SolidOperationManager } = await import("src/features/setup/rendering/SolidOperationManager");
  const sketch: SerializedSketch = { plane: XY_PLANE, geometries };
  const manager = new SolidOperationManager(new THREE.Scene(), (key) => (key === KEY ? sketch : null));
  // 같은 스케치의 hole 원으로 target 을 자르는 Pocket
  const pocket: PadPocketOperation = {
    id: "op2", type: "pocket", sketchPlaneKey: KEY, profileIds: ["shape_hole"], depth: 10, direction: "normal",
    targetOperationId: target.id,
  };
  const operations: OperationTreeEntry[] = [
    { operation: target, sketchPlaneName: "Sketch 1" },
    { operation: pocket, sketchPlaneName: "Sketch 1" },
  ];
  // 파일을 열 때(SetupCanvas pendingRestore)와 편집 없이 스케치를 닫을 때 도는 호출
  await manager.rebuildOperationsForSketch(KEY, operations);
  return manager;
}

for (const delay of [3, 0]) {
  test(`같은 스케치의 Pad 를 대상으로 한 Pocket 이 rebuild 뒤에도 남는다 (IPC 지연 ${delay}ms)`, async () => {
    // 고치기 전에는 rebuild 가 Pad·Pocket 의 add 를 기다리지 않고 함께 시작했다. Pocket 은 대상에 native shape 가
    // 없어 IPC 없이 바로 폴백 CSG 로 갔고, 그때 Pad 메시는 add 첫머리에서 이미 지워진 뒤라 대상을 못 찾고 메시 없이 끝났다
    ipcDelayMs = delay;
    const disk: SerializedGeometry = { type: "circle", id: "disk", cx: 5, cy: 5, r: 5 };
    const hole: SerializedGeometry = { type: "circle", id: "hole", cx: 5, cy: 5, r: 2 };
    const pad: PadPocketOperation = {
      id: "op1", type: "pad", sketchPlaneKey: KEY, profileIds: ["shape_disk"], depth: 10, direction: "normal",
    };
    const manager = await rebuild([disk, hole], pad);
    const pocketMesh = manager.extrudedSolids.get("op2");
    assert.ok(pocketMesh, "Pocket 솔리드가 있어야 한다");
    assert.equal(pocketMesh.visible, true);
    assert.equal(pocketMesh.userData.sourceOperationId, "op1");
    assert.equal(manager.extrudedSolids.get("op1")?.visible, false, "Pocket 에 소비된 Pad 는 숨긴다");
  });
}

test("같은 스케치의 Revolve 를 대상으로 한 Pocket 이 rebuild 뒤에도 남는다", async () => {
  // Revolve 도 add 첫머리에서 옛 메시를 지우고 IPC 를 기다리므로, 함께 시작한 Pocket 이 대상을 못 찾았다
  ipcDelayMs = 3;
  // ring 원을 Y 축으로 한 바퀴 돌린 토러스(중심 반지름 4, 굵기 2) — 축 위의 hole 원을 z 방향으로 뚫으면 토러스를 자른다.
  // 프로파일은 native 경로가 IPC 를 보내도록 닫힌 도형으로 찾히는 원으로 둔다.
  const ring: SerializedGeometry = { type: "circle", id: "ring", cx: 4, cy: 5, r: 2 };
  const hole: SerializedGeometry = { type: "circle", id: "hole", cx: 0, cy: 5, r: 1 };
  const revolve: RevolveOperation = {
    id: "op1", type: "revolve", sketchPlaneKey: KEY, profileIds: ["shape_ring"], angle: 360, axisType: "y",
    revolveDirection: "normal", clockwise: false,
  };
  const manager = await rebuild([ring, hole], revolve);
  const pocketMesh = manager.extrudedSolids.get("op2");
  assert.ok(pocketMesh, "Pocket 솔리드가 있어야 한다");
  assert.equal(pocketMesh.visible, true);
  assert.equal(pocketMesh.userData.sourceOperationId, "op1");
  assert.equal(manager.extrudedSolids.get("op1")?.visible, false, "Pocket 에 소비된 Revolve 는 숨긴다");
});
