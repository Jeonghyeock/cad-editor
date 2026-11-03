import "./support/browserStubs";

import * as THREE from "three";

import assert from "node:assert/strict";
import { test } from "node:test";

import { SceneManager } from "src/features/setup/rendering/SceneManager";

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
  sm.switchToOrtho(() => {});
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
