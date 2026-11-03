import "./support/browserStubs";

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelManager } from "src/features/setup/rendering/ModelManager";
import type { StepBodyData, StepModelData } from "src/features/setup/Setup.type";
import { createStepModelGroup, highlightVertex, pickFace, pickVertex } from "src/features/setup/step/StepModelManager";

// 화면 800×600, 실제 three.js 카메라·Raycaster 로 픽킹한다.
const W = 800;
const H = 600;

function makeCamera(position: THREE.Vector3, target: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 2000);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

const toScreen = (p: THREE.Vector3, camera: THREE.Camera) => {
  const n = p.clone().project(camera);
  return new THREE.Vector2(((n.x + 1) / 2) * W, ((1 - n.y) / 2) * H);
};

const ndcOf = (screen: THREE.Vector2) => new THREE.Vector2((screen.x / W) * 2 - 1, 1 - (screen.y / H) * 2);

function rayAt(screen: THREE.Vector2, camera: THREE.Camera): THREE.Raycaster {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndcOf(screen), camera);
  return raycaster;
}

// 중심 (cx,cy,cz), 크기 (sx,sy,sz) 상자 몸체
function boxBody(name: string, size: [number, number, number], center: [number, number, number]): StepBodyData {
  const geo = new THREE.BoxGeometry(...size).translate(...center);
  return {
    name,
    positions: Array.from(geo.getAttribute("position").array),
    normals: Array.from(geo.getAttribute("normal").array),
    indices: Array.from(geo.getIndex()!.array),
    brepFaces: [],
  };
}

const stepModel = (id: string, bodies: StepBodyData[]): StepModelData => ({
  id,
  fileName: `${id}.step`,
  bodies,
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
});

function makeModelManager(): ModelManager {
  const controls = { target: new THREE.Vector3(), update: () => {} } as unknown as OrbitControls;
  return new ModelManager(new THREE.Scene(), controls);
}

test("꼭짓점 하이라이트 구슬을 맞혀도 몸체의 꼭짓점·면·bodyIndex 를 돌려준다", () => {
  // 고치기 전에는 group.traverse 로 모은 Mesh 에 하이라이트 구슬까지 들어가, 꼭짓점에 hover 한 뒤 1px 움직이면
  // 구슬을 맞혀 bodyIndex 가 0↔1 로 번갈아 나오고 구슬의 꼭짓점(꼭짓점에서 1.2 벗어난 곳)을 돌려주었다
  const group = createStepModelGroup(stepModel("M", [boxBody("box", [10, 10, 10], [0, 0, 0])]));
  group.updateMatrixWorld(true);
  const camera = makeCamera(new THREE.Vector3(30, 25, 40), new THREE.Vector3(0, 0, 0));
  const corner = new THREE.Vector3(5, 5, 5); // 카메라 쪽 꼭짓점 — 실루엣 한가운데
  const at = toScreen(corner, camera);

  const first = pickVertex(rayAt(at, camera), group, camera, W, H, at);
  assert.ok(first);
  assert.equal(first.bodyIndex, 0);
  assert.ok(first.point.distanceTo(corner) < 1e-4);

  // hover 표시 후 다음 렌더처럼 행렬을 갱신하고 1px 옆에서 다시 고른다
  highlightVertex(group, first.bodyIndex, first.vertexIndex);
  group.updateMatrixWorld(true);
  const moved = new THREE.Vector2(at.x + 1, at.y);
  const again = pickVertex(rayAt(moved, camera), group, camera, W, H, moved);
  assert.ok(again);
  assert.equal(again.bodyIndex, 0);
  assert.ok(again.point.distanceTo(corner) < 1e-4, `꼭짓점=${again.point.toArray()}`);

  // 면 픽킹도 구슬 표면이 아니라 상자 표면의 점을 돌려준다
  const face = pickFace(rayAt(moved, camera), group);
  assert.ok(face);
  const maxCoord = Math.max(Math.abs(face.point.x), Math.abs(face.point.y), Math.abs(face.point.z));
  assert.ok(Math.abs(maxCoord - 5) < 1e-4, `면 위 점=${face.point.toArray()}`);
});

test("body 픽킹도 하이라이트 구슬이 아닌 몸체의 bodyIndex 를 돌려준다", () => {
  const mm = makeModelManager();
  mm.addStepModel(stepModel("M", [boxBody("box", [10, 10, 10], [0, 0, 0])]), new THREE.PerspectiveCamera());
  const group = mm.getStepModelGroup("M")!;
  group.updateMatrixWorld(true);
  // addStepModel 이 바닥을 y=0 으로 옮기므로 카메라 쪽 꼭짓점은 (5,10,5)
  const camera = makeCamera(new THREE.Vector3(30, 30, 40), new THREE.Vector3(0, 5, 0));
  const corner = new THREE.Vector3(5, 10, 5);
  const at = toScreen(corner, camera);
  const v = mm.pickStepVertex(ndcOf(at), at, new THREE.Raycaster(), camera, W, H);
  assert.ok(v);
  assert.ok(v.point.distanceTo(corner) < 1e-4);
  mm.highlightVertex("M", v.bodyIndex, v.vertexIndex);
  group.updateMatrixWorld(true);

  const moved = new THREE.Vector2(at.x + 1, at.y);
  assert.deepEqual(mm.pickBody(ndcOf(moved), new THREE.Raycaster(), camera), { modelId: "M", bodyIndex: 0 });
});

test("겹친 STEP 모델 중 먼저 추가된 모델이 아니라 광선이 먼저 닿는 모델을 고른다", () => {
  // 고치기 전에는 모델을 추가 순서로 돌며 처음 맞힌 모델을 돌려줘, 판 A 위의 기둥 B 를 가리키면
  // 광선이 B 를 지나 맞힌 A 의 윗면이 hover·선택되었다 (모든 STEP 은 XZ 중심·바닥 y=0 으로 옮겨 서로 겹친다)
  const mm = makeModelManager();
  mm.addStepModel(stepModel("A", [boxBody("plate", [300, 10, 300], [0, 0, 0])]), new THREE.PerspectiveCamera());
  mm.addStepModel(stepModel("B", [boxBody("pillar", [10, 80, 10], [0, 0, 0])]), new THREE.PerspectiveCamera());
  for (const id of ["A", "B"]) mm.getStepModelGroup(id)!.updateMatrixWorld(true);

  // B 의 앞면 (0,50,5) 을 가리킨다. 광선은 B 를 지나 A 의 윗면 (0,10,-111) 에도 닿는다
  const camera = makeCamera(new THREE.Vector3(0, 100, 150), new THREE.Vector3(0, 30, 0));
  const ndc = ndcOf(toScreen(new THREE.Vector3(0, 50, 5), camera));

  const face = mm.pickStepFace(ndc, new THREE.Raycaster(), camera);
  assert.equal(face?.modelId, "B");
  assert.ok(face && Math.abs(face.point.z - 5) < 1e-4, `면 위 점=${face?.point.toArray()}`);
  assert.deepEqual(mm.pickBody(ndc, new THREE.Raycaster(), camera), { modelId: "B", bodyIndex: 0 });
});

test("숨긴 모델·몸체는 면·엣지·꼭짓점으로 잡히지 않는다", () => {
  // 고치기 전에는 pickBody 만 숨김을 걸렀고, 면·엣지·꼭짓점 픽킹은 숨긴 모델도 레이캐스트했다
  const mm = makeModelManager();
  mm.addStepModel(stepModel("A", [boxBody("plate", [300, 10, 300], [0, 0, 0])]), new THREE.PerspectiveCamera());
  mm.getStepModelGroup("A")!.updateMatrixWorld(true);
  const camera = makeCamera(new THREE.Vector3(0, 200, 400), new THREE.Vector3(0, 0, 0));

  const facePt = toScreen(new THREE.Vector3(40, 10, 100), camera); // 윗면 안쪽
  const edgePt = toScreen(new THREE.Vector3(40, 10, 150), camera); // 윗면·앞면 사이 엣지
  const cornerPt = toScreen(new THREE.Vector3(150, 10, 150), camera).add(new THREE.Vector2(-2, -1)); // 꼭짓점 바로 안쪽
  const pickAll = () => ({
    face: mm.pickStepFace(ndcOf(facePt), new THREE.Raycaster(), camera),
    edge: mm.pickStepEdge(ndcOf(edgePt), edgePt, new THREE.Raycaster(), camera, W, H),
    vertex: mm.pickStepVertex(ndcOf(cornerPt), cornerPt, new THREE.Raycaster(), camera, W, H),
  });

  // 보일 때는 셋 다 잡힌다 (겨냥이 맞는지 확인)
  const shown = pickAll();
  assert.ok(shown.face && shown.edge && shown.vertex);

  mm.setModelVisible("A", false);
  assert.deepEqual(pickAll(), { face: null, edge: null, vertex: null });

  mm.setModelVisible("A", true);
  mm.setBodyVisible("A", 0, false);
  assert.deepEqual(pickAll(), { face: null, edge: null, vertex: null });
});
