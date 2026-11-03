import * as THREE from "three";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { OcctChannels } from "src/app/channels/occtChannels";

import type {
  PadPocketOperation,
  RevolveOperation,
  SerializedGeometry,
  SerializedSketch,
} from "src/features/setup/Setup.type";

// C++ 애드온을 빌드한 환경을 흉내 낸다. native 는 2-Dim·draft·reverse·two-angles·CW 를 모르므로
// 어떤 인자가 와도 [0,10]³ 상자를 돌려준다 — 이 상자가 결과에 쓰이면 옵션이 무시된 것이다.
const calls: string[] = [];
let nextHandle = 1;
// true 면 부울 연산 결과의 메시가 깨져 와 메시 변환에서 실패한다
let brokenBoolean = false;
function nativeBox() {
  const g = new THREE.BoxGeometry(10, 10, 10).translate(5, 5, 5);
  return {
    shapeHandle: nextHandle++,
    mesh: {
      positions: Array.from(g.getAttribute("position").array),
      normals: Array.from(g.getAttribute("normal").array),
      indices: Array.from(g.index!.array),
    },
  };
}
(globalThis as Record<string, unknown>).window = {
  electron: {
    ipcRenderer: {
      invoke: async (channel: string) => {
        calls.push(channel);
        if (brokenBoolean && channel === OcctChannels.PERFORM_BOOLEAN) return { shapeHandle: nextHandle++, mesh: null };
        return nativeBox();
      },
    },
  },
};

beforeEach(() => {
  calls.length = 0;
  brokenBoolean = false;
});

const XY_PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
};
// native 경로는 detectClosedShapes 가 찾은 닫힌 도형만 보내므로 원으로 프로파일을 만든다
const disk: SerializedGeometry = { type: "circle", id: "disk", cx: 5, cy: 5, r: 5 };
const hole: SerializedGeometry = { type: "circle", id: "hole", cx: 5, cy: 5, r: 2 };
const sketches: Record<string, SerializedSketch> = {
  disk: { plane: XY_PLANE, geometries: [disk] },
  hole: { plane: XY_PLANE, geometries: [hole] },
};
const geometriesOf = (key: string) => new Map(sketches[key].geometries!.map((g) => [g.id, g]));

async function createManager() {
  const { SolidOperationManager } = await import("src/features/setup/rendering/SolidOperationManager");
  return new SolidOperationManager(new THREE.Scene(), (key) => sketches[key] ?? null);
}

const pad = (op: Partial<PadPocketOperation>): PadPocketOperation => ({
  id: "pad",
  type: "pad",
  sketchPlaneKey: "disk",
  profileIds: [],
  depth: 10,
  direction: "normal",
  ...op,
});

const revolveOp = (op: Partial<RevolveOperation>): RevolveOperation => ({
  id: "rev",
  type: "revolve",
  sketchPlaneKey: "disk",
  profileIds: [],
  angle: 90,
  axisType: "y",
  revolveDirection: "normal",
  clockwise: false,
  ...op,
});

function boundingBox(obj: THREE.Object3D | undefined): THREE.Box3 {
  assert.ok(obj instanceof THREE.Mesh, "솔리드가 만들어져야 한다");
  obj.geometry.computeBoundingBox();
  return obj.geometry.boundingBox!;
}

test("옵션이 없는 Pad·Revolve 는 그대로 native 로 만든다", async () => {
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({}), geometriesOf("disk"));
  await manager.addRevolvedSolid(revolveOp({}), geometriesOf("disk"));
  await manager.addRevolvedSolid(revolveOp({ id: "sym", angle: 180, revolveDirection: "symmetric" }), geometriesOf("disk"));
  assert.ok(calls.includes(OcctChannels.BUILD_PRISM));
  assert.equal(calls.filter((c) => c === OcctChannels.BUILD_REVOLUTION).length, 3);
});

test("2-Dim Pad 는 폴백으로 만들어 반대 방향 깊이(depth2)를 지킨다", async () => {
  // 고치기 전에는 native 가 depth2 를 버리고 정방향 depth 만 만들었다
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({ direction: "two-dimensions", depth2: 5 }), geometriesOf("disk"));
  assert.ok(!calls.includes(OcctChannels.BUILD_PRISM));
  const box = boundingBox(manager.extrudedSolids.get("pad"));
  assert.ok(Math.abs(box.min.z + 5) < 1e-6 && Math.abs(box.max.z - 10) < 1e-6, `z 범위 ${box.min.z}..${box.max.z}`);
});

test("Draft Pad 는 폴백으로 만들어 테이퍼를 지킨다", async () => {
  // 고치기 전에는 native 가 draftAngle 을 무시해 곧은 기둥이 됐다
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({ draftAngle: 10 }), geometriesOf("disk"));
  assert.ok(!calls.includes(OcctChannels.BUILD_PRISM));
  const mesh = manager.extrudedSolids.get("pad") as THREE.Mesh;
  const pos = mesh.geometry.getAttribute("position");
  let topMaxX = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i) - 10) < 1e-6) topMaxX = Math.max(topMaxX, pos.getX(i));
  }
  assert.ok(topMaxX < 10 - 1e-3, `윗면이 좁아져야 하는데 x 최대값이 ${topMaxX}`);
});

test("native 로 만든 Pad 에 Draft Pocket 을 해도 폴백 CSG 로 구멍을 낸다", async () => {
  // native 메시에는 uv 가 없어, three-bvh-csg 기본 설정(position·uv·normal)으로는 폴백 CSG 가 실패했다
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({}), geometriesOf("disk"));
  calls.length = 0;
  await manager.addExtrudedSolid(
    pad({ id: "pocket", type: "pocket", sketchPlaneKey: "hole", draftAngle: 5, targetOperationId: "pad" }),
    geometriesOf("hole"),
  );
  assert.deepEqual(calls, [], "Draft Pocket 은 native 를 부르지 않아야 한다");
  boundingBox(manager.extrudedSolids.get("pocket"));
  assert.equal(manager.extrudedSolids.get("pad")!.visible, false);
});

test("폴백으로 다시 만든 솔리드에는 이전 native shape 가 남지 않는다", async () => {
  // Pad 를 Draft 로 편집해 폴백으로 다시 만들었는데 옛 handle 이 남으면, 다음 native Pocket 이
  // 테이퍼 없는 옛 형상을 자른다
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({}), geometriesOf("disk"));
  await manager.addExtrudedSolid(pad({ draftAngle: 10 }), geometriesOf("disk"));
  calls.length = 0;
  await manager.addExtrudedSolid(
    pad({ id: "pocket", type: "pocket", sketchPlaneKey: "hole", targetOperationId: "pad" }),
    geometriesOf("hole"),
  );
  assert.ok(!calls.includes(OcctChannels.PERFORM_BOOLEAN), "옛 native shape 로 부울 연산을 하면 안 된다");
  boundingBox(manager.extrudedSolids.get("pocket"));
});

test("reverse·two-angles·CW Revolve 는 폴백으로 만든다", async () => {
  // 고치기 전에는 native 가 이 옵션들을 무시해 normal 과 같은 쪽, angle 만큼만 돌렸다
  const manager = await createManager();
  await manager.addRevolvedSolid(revolveOp({ revolveDirection: "reverse" }), geometriesOf("disk"));
  await manager.addRevolvedSolid(
    revolveOp({ id: "two", angle: 90, angle2: 45, revolveDirection: "two-angles" }),
    geometriesOf("disk"),
  );
  await manager.addRevolvedSolid(revolveOp({ id: "cw", clockwise: true }), geometriesOf("disk"));
  assert.ok(!calls.includes(OcctChannels.BUILD_REVOLUTION));
  // 폴백 결과: Y 축 기준 reverse 90° 는 +Z 쪽([-90°, 0°])을 쓸어 z 가 0..10 이다
  const reverse = boundingBox(manager.extrudedSolids.get("rev"));
  assert.ok(Math.abs(reverse.max.z - 10) < 1e-6 && Math.abs(reverse.min.z) < 1e-6, `z 범위 ${reverse.min.z}..${reverse.max.z}`);
  boundingBox(manager.extrudedSolids.get("two"));
  boundingBox(manager.extrudedSolids.get("cw"));
});

test("native Pocket 이 원본을 소비한 뒤 원본을 native 로 다시 만들어도 숨긴 채로 둔다", async () => {
  // 고치기 전에는 IPC 를 기다린 뒤 새 원본 메시가 visible=true 로 들어가 구멍을 덮었다
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({}), geometriesOf("disk"));
  await manager.addExtrudedSolid(
    pad({ id: "pocket", type: "pocket", sketchPlaneKey: "hole", targetOperationId: "pad" }),
    geometriesOf("hole"),
  );
  assert.ok(calls.includes(OcctChannels.PERFORM_BOOLEAN));
  await manager.addExtrudedSolid(pad({ depth: 12 }), geometriesOf("disk"));
  assert.equal(manager.extrudedSolids.get("pad")!.visible, false);
  assert.equal(manager.extrudedSolids.get("pocket")!.visible, true);
});

test("native 부울 연산 뒤 메시 변환이 실패하면 원본을 숨기지 않는다", async () => {
  // 고치기 전에는 결과 메시를 씬에 넣기 전에 원본을 숨기고 소비를 기록해, 뒤에서 실패하면 결과 없이
  // 원본만 사라졌다. 폴백도 못 만들게 Pocket 에는 스케치 밖 기하를 주지 않는다(native 는 저장된 스케치를 쓴다).
  const manager = await createManager();
  await manager.addExtrudedSolid(pad({}), geometriesOf("disk"));
  brokenBoolean = true;
  await manager.addExtrudedSolid(
    pad({ id: "pocket", type: "pocket", sketchPlaneKey: "hole", targetOperationId: "pad" }),
    new Map(),
  );
  assert.ok(calls.includes(OcctChannels.PERFORM_BOOLEAN));
  assert.equal(manager.extrudedSolids.get("pocket"), undefined);
  assert.equal(manager.extrudedSolids.get("pad")!.visible, true);
  manager.setExtrudedSolidsVisible(true);
  assert.equal(manager.extrudedSolids.get("pad")!.visible, true);
});
