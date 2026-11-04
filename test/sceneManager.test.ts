import "./support/browserStubs";
import "./support/windowStub";

import * as THREE from "three";

import assert from "node:assert/strict";
import { test } from "node:test";

import { SceneManager } from "src/features/setup/rendering/SceneManager";
import { buildPlaneCoordSystem } from "src/features/setup/step/ProfileProjector";

// WebGL 렌더러는 node 에서 만들 수 없어, 그리지 않는 대체물로 바꾼다. 카메라·OrbitControls·Box3 는 실제 three.js 다.
class FakeRenderer {
  domElement: HTMLCanvasElement;
  autoClear = true;
  constructor({ canvas }: { canvas: HTMLCanvasElement }) {
    this.domElement = canvas;
  }
  setPixelRatio() {}
  setSize() {}
  setClearColor() {}
  render() {}
  clearDepth() {}
  dispose() {}
}
require.cache[require.resolve("three")]!.exports.WebGLRenderer = FakeRenderer;

// 카메라 애니메이션은 requestAnimationFrame 으로 돈다. 16ms 타이머로 흉내 낸다.
const g = globalThis as Record<string, unknown>;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);

function makeSceneManager(): SceneManager {
  const noop = () => {};
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    getRootNode: () => ({ addEventListener: noop, removeEventListener: noop }),
  } as unknown as HTMLCanvasElement;
  return new SceneManager(canvas);
}

const box = (size: number) => new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial());

test("zoomToFit 은 숨긴 모델과 보이지 않는 raycast 평면을 빼고 보이는 기하에만 맞춘다", () => {
  // 고치기 전에는 mesh.visible 만 보아, group 만 숨긴 모델과 material.visible=false 인 10000×10000 스케치 평면까지
  // bbox 에 넣었다. 스케치 모드에서 Home 을 누르면 ortho halfH 가 6000 이 되어 스케치가 점처럼 작아졌다.
  const sm = makeSceneManager();
  sm.scene.add(box(20)); // 보이는 모델: 원점 중심 20×20×20
  const hiddenModel = new THREE.Group(); // ModelManager.setModelVisible 처럼 group 만 숨긴다
  hiddenModel.visible = false;
  const far = box(20);
  far.position.set(1000, 0, 0);
  hiddenModel.add(far);
  sm.scene.add(hiddenModel);
  // SketchPlaneManager 의 raycast 전용 평면과 같은 것
  sm.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000), new THREE.MeshBasicMaterial({ visible: false })));

  // 3D: 보이는 상자(maxDim 20)에 맞는 거리로 다가간다
  sm.zoomToFit();
  const fov = (sm.perspCamera.fov * Math.PI) / 180;
  const expectedDist = (20 / (2 * Math.tan(fov / 2))) * 1.5;
  assert.ok(Math.abs(sm.perspCamera.position.distanceTo(sm.controls.target) - expectedDist) < 1e-6);
  assert.ok(sm.controls.target.length() < 1e-9);

  // 스케치(ortho): halfH = maxDim × 0.6
  sm.switchToOrtho(() => {}, new THREE.Vector3(0, 1, 0));
  sm.zoomToFit();
  assert.ok(Math.abs(sm.orthoCamera.top - 12) < 1e-9, `halfH=${sm.orthoCamera.top}`);
});

// 카메라의 화면 위쪽이 월드에서 가리키는 방향
const screenUpOf = (cam: THREE.Camera) => new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);

test("ViewCube 로 위에서 본 뒤 궤도 회전해도 화면이 눕지 않는다", async () => {
  // 고치기 전에는 ViewCube Y 축 클릭이 camera.up 을 (0,0,-1) 로 바꾼 채 두었다. OrbitControls 는 생성 때 up (0,1,0) 을
  // 축으로 도는데 lookAt 은 바뀐 up 을 써서, 위에서 옆으로 내려오면 월드 Y 가 화면 가로가 되었다.
  const sm = makeSceneManager();
  const cam = sm.perspCamera;
  sm.animateCameraToDirection(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
  await new Promise((resolve) => setTimeout(resolve, 500)); // 300ms 애니메이션이 끝날 때까지

  // 위에서 본 화면은 ViewCube 가 정한 대로 화면 위쪽이 -Z 이고, up 은 원래대로 (0,1,0)
  assert.ok(screenUpOf(cam).dot(new THREE.Vector3(0, 0, -1)) > 0.999);
  assert.deepEqual(cam.up.toArray(), [0, 1, 0]);

  // 옆으로 90° 돌고 0.5 rad 내려오는 궤도 회전 뒤에도 월드 Y 가 화면 위쪽을 향한다
  const orbit = sm.controls as unknown as { _rotateLeft(a: number): void; _rotateUp(a: number): void };
  orbit._rotateLeft(Math.PI / 2);
  orbit._rotateUp(-0.5);
  sm.controls.update();
  assert.ok(screenUpOf(cam).y > 0.4, `화면 위쪽=${screenUpOf(cam).toArray()}`);
});

test("up=(0,0,-1) 로 저장된 카메라 상태를 적용해도 궤도 회전이 눕지 않는다", () => {
  // 고치기 전에는 applyCameraState 가 저장된 up 을 그대로 써서, 예전 빌드가 ViewCube 위 뷰 뒤에 남긴
  // up=(0,0,-1) 상태를 되살리면 #36 과 같이 궤도 회전에서 화면이 누웠다
  const sm = makeSceneManager();
  sm.applyCameraState({
    persp: { position: [0, 200, 0.0002], quaternion: [0, 0, 0, 1], up: [0, 0, -1] },
    target: [0, 0, 0],
  });
  assert.deepEqual(sm.perspCamera.up.toArray(), [0, 1, 0]);

  // 옆으로 90° 돌고 0.5 rad 내려오는 궤도 회전 뒤에도 월드 Y 가 화면 위쪽을 향한다
  const orbit = sm.controls as unknown as { _rotateLeft(a: number): void; _rotateUp(a: number): void };
  orbit._rotateLeft(Math.PI / 2);
  orbit._rotateUp(-0.5);
  sm.controls.update();
  assert.ok(screenUpOf(sm.perspCamera).y > 0.4, `화면 위쪽=${screenUpOf(sm.perspCamera).toArray()}`);
});

test("ViewCube 애니메이션이 스케치 진입으로 끊겨도 3D 로 돌아오면 up 은 (0,1,0) 이다", async () => {
  // 고치기 전에는 switchToPersp 가 보간 중이던 up 을 그대로 되살려 이후 궤도 회전이 기울었다
  const sm = makeSceneManager();
  sm.animateCameraToDirection(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
  await new Promise((resolve) => setTimeout(resolve, 100)); // 300ms 애니메이션의 앞부분만
  assert.notDeepEqual(sm.perspCamera.up.toArray(), [0, 1, 0]); // 보간 중
  sm.placeCameraAtPlane(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1), new Map()); // 애니메이션 취소
  sm.switchToOrtho(() => {}, new THREE.Vector3(0, 1, 0));
  sm.switchToPersp();
  assert.deepEqual(sm.perspCamera.up.toArray(), [0, 1, 0]);
});

test("스케치 평면이 수평이어도 스케치 H 축은 화면 오른쪽, V 축은 화면 위쪽을 향한다", () => {
  // 고치기 전에는 ortho 카메라 up 을 perspective 의 (0,1,0) 그대로 써서, 수평 평면(|n.y|≥0.9 라 upHint 가 X)에서
  // 스케치 축이 화면 기준 90° 돌았다(ZX 평면에서 H=+Z 가 화면 아래). 원점이 아닌 윗면은 법선의 부동소수 잔차에
  // 따라 임의 각도로 돌았다. 규약(u/v)은 그대로 두고 화면 정렬만 맞춘다.
  const cases: { name: string; origin: THREE.Vector3; normal: THREE.Vector3 }[] = [
    { name: "ZX", origin: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 1, 0) },
    { name: "STEP 윗면", origin: new THREE.Vector3(37, 25, -12), normal: new THREE.Vector3(1e-9, 1, -2e-9).normalize() },
    { name: "아랫면", origin: new THREE.Vector3(0, -5, 0), normal: new THREE.Vector3(0, -1, 0) },
    { name: "XY", origin: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 0, 1) },
    { name: "YZ", origin: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(1, 0, 0) },
  ];
  for (const { name, origin, normal } of cases) {
    // 기준 평면(SketchPlaneManager.getOriginPlaneAsSketchPlane)과 면 스케치가 쓰는 같은 규약 — ZX 는 H=Z, V=X
    const { u, v } = buildPlaneCoordSystem(normal);
    const sm = makeSceneManager();
    sm.placeCameraAtPlane(origin, normal, new Map());
    sm.switchToOrtho(() => {}, new THREE.Vector3(v.x, v.y, v.z));
    const cam = sm.orthoCamera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    assert.ok(right.dot(new THREE.Vector3(u.x, u.y, u.z)) > 0.999, `${name}: 화면 오른쪽=${right.toArray()}`);
    assert.ok(screenUpOf(cam).dot(new THREE.Vector3(v.x, v.y, v.z)) > 0.999, `${name}: 화면 위쪽=${screenUpOf(cam).toArray()}`);
  }
});
