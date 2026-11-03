import * as THREE from "three";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RevolveOperation, SerializedGeometry, SerializedSketch } from "src/features/setup/Setup.type";

// C++ 애드온이 없는 기본 설치를 흉내 낸다 — native IPC 는 실패하고 Three.js 폴백(LatheGeometry)이 결과를 만든다.
(globalThis as Record<string, unknown>).window = {
  electron: { ipcRenderer: { invoke: async () => { throw new Error("native addon 없음"); } } },
};

const XY_PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
};

// 스케치 좌표 (x0..x1, y0..y1) 사각형 프로파일
const rect = (x0: number, y0: number, x1: number, y1: number): SerializedGeometry => ({
  type: "polygon",
  id: "rect",
  vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  lineIds: [],
});

async function revolve(profile: SerializedGeometry, op: Partial<RevolveOperation>): Promise<THREE.Mesh> {
  const { SolidOperationManager } = await import("src/features/setup/rendering/SolidOperationManager");
  const sketch: SerializedSketch = { plane: XY_PLANE, geometries: [profile] };
  const manager = new SolidOperationManager(new THREE.Scene(), () => sketch);
  const operation: RevolveOperation = {
    id: "rev",
    type: "revolve",
    sketchPlaneKey: "xy",
    profileIds: [],
    angle: 90,
    axisType: "y",
    revolveDirection: "normal",
    clockwise: false,
    ...op,
  };
  await manager.addRevolvedSolid(operation, new Map([[profile.id, profile]]));
  const mesh = manager.extrudedSolids.get("rev");
  assert.ok(mesh instanceof THREE.Mesh, "회전 솔리드가 만들어져야 한다");
  return mesh;
}

/**
 * 솔리드가 프로파일 반평면(시작 방향 start)에서 회전축 axis 를 기준으로 오른손 방향으로 몇 도에서 몇 도까지
 * 쓸었는지 잰다. native(OCCT MakeRevol)도 축 방향 기준 오른손 회전이다.
 */
function sweptDegrees(mesh: THREE.Mesh, axis: THREE.Vector3, start: THREE.Vector3) {
  const side = new THREE.Vector3().crossVectors(axis, start); // start 를 axis 로 90° 돌린 방향
  const pos = mesh.geometry.getAttribute("position");
  const p = new THREE.Vector3();
  let min = Infinity, max = -Infinity, maxRadius = 0;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const radial = p.clone().sub(axis.clone().multiplyScalar(p.dot(axis)));
    const r = radial.length();
    maxRadius = Math.max(maxRadius, r);
    if (r < 1e-6) continue;
    const deg = (Math.atan2(radial.dot(side), radial.dot(start)) * 180) / Math.PI;
    min = Math.min(min, deg);
    max = Math.max(max, deg);
  }
  return { min, max, maxRadius };
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

function assertSweep(actual: { min: number; max: number }, from: number, to: number) {
  assert.ok(
    Math.abs(actual.min - from) < 0.01 && Math.abs(actual.max - to) < 0.01,
    `쓸어낸 각도가 [${from}°, ${to}°] 여야 하는데 [${actual.min.toFixed(2)}°, ${actual.max.toFixed(2)}°] 다`,
  );
}

test("Revolve 폴백 — Y 축 normal 90° 는 프로파일에서 시작해 90° 를 쓴다", async () => {
  // 고치기 전에는 LatheGeometry 의 φ=0 을 스케치 평면으로 잡아, 프로파일 뒤쪽 [-90°, 0°] 를 썼다
  const mesh = await revolve(rect(5, 0, 10, 4), { angle: 90 });
  assertSweep(sweptDegrees(mesh, Y, X), 0, 90);
});

test("Revolve 폴백 — 45° 는 프로파일에 붙은 [0°, 45°] 다", async () => {
  // 고치기 전에는 프로파일과 떨어진 곳을 쓸었다
  const mesh = await revolve(rect(5, 0, 10, 4), { angle: 45 });
  assertSweep(sweptDegrees(mesh, Y, X), 0, 45);
});

test("Revolve 폴백 — symmetric 180° 는 프로파일 양쪽으로 90° 씩이다", async () => {
  // 고치기 전에는 normal 180° 와 symmetric 180° 의 결과가 뒤바뀌었다
  const mesh = await revolve(rect(5, 0, 10, 4), { angle: 180, revolveDirection: "symmetric" });
  assertSweep(sweptDegrees(mesh, Y, X), -90, 90);
});

test("Revolve 폴백 — reverse·two-angles·CW 도 프로파일을 기준으로 잰다", async () => {
  const reverse = await revolve(rect(5, 0, 10, 4), { angle: 90, revolveDirection: "reverse" });
  assertSweep(sweptDegrees(reverse, Y, X), -90, 0);
  const twoAngles = await revolve(rect(5, 0, 10, 4), { angle: 60, angle2: 30, revolveDirection: "two-angles" });
  assertSweep(sweptDegrees(twoAngles, Y, X), -30, 60);
  const clockwise = await revolve(rect(5, 0, 10, 4), { angle: 90, clockwise: true });
  assertSweep(sweptDegrees(clockwise, Y, X), -90, 0);
});

test("Revolve 폴백 — 축의 음수 쪽 프로파일도 폭을 잃지 않는다", async () => {
  // 고치기 전에는 Math.max(0, dist) 가 모든 점을 축 위로 눌러 360° 에서도 폭 0 솔리드가 됐다
  const mesh = await revolve(rect(-10, 0, -5, 4), { angle: 90 });
  const swept = sweptDegrees(mesh, Y, X.clone().negate());
  assert.ok(Math.abs(swept.maxRadius - 10) < 1e-6, `최대 반지름이 10 이어야 하는데 ${swept.maxRadius}`);
  assertSweep(swept, 0, 90);
});

test("Revolve 폴백 — X 축도 축 방향 기준 오른손 회전이다 (native 와 같은 쪽)", async () => {
  // 고치기 전에는 (v, u, n) 왼손 기저로 변환해 X 축 회전만 반대쪽으로 돌았다(90° 에서만 우연히 맞았다)
  const mesh = await revolve(rect(0, 5, 4, 10), { angle: 45, axisType: "x" });
  assertSweep(sweptDegrees(mesh, X, Y), 0, 45);
});

test("Revolve 폴백 — custom 축(원점 (0,0), 방향 (0,1))은 Y 축과 같다", async () => {
  const mesh = await revolve(rect(5, 0, 10, 4), {
    angle: 90,
    axisType: "custom",
    axisOrigin: { x: 0, y: 0 },
    axisDirection: { x: 0, y: 1 },
  });
  assertSweep(sweptDegrees(mesh, Y, X), 0, 90);
});
