import * as jotai from "jotai";
import * as React from "react";
import * as THREE from "three";

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  OperationTreeEntry,
  PadPocketOperation,
  SerializedGeometry,
  SerializedSketch,
  SketchPlane,
  StepModelData,
} from "src/features/setup/Setup.type";

// STEP 면 스케치 → Pad → 저장 → 다시 열기를 실제 useCrossSectionMode·SketchPlaneManager·BakedSketchManager·
// SolidOperationManager 로 흉내 낸다. 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 대신할 모듈을 넣어
// React 없이 훅을 부르고, node 에서 읽을 수 없는 모듈(svg 를 불러오는 store·overlayConstants)은 대체한다.
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};

// 원점에서 떨어진 STEP 모델의 윗면 하나 (모델 좌표 y=50, x 100..120, z 200..220)
const model: StepModelData = {
  id: "m1",
  fileName: "part.step",
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  bodies: [{
    name: "body",
    positions: [100, 50, 200, 100, 50, 220, 120, 50, 220, 120, 50, 200],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    brepFaces: [{ first: 0, last: 1 }],
  }],
};
// ModelManager 가 화면에 놓으려고 더하는 모델 오프셋
const OFFSET = new THREE.Vector3(-110, -20, -210);

stub("react", { ...React, useCallback: (fn: unknown) => fn });
stub("jotai", { ...jotai, useAtomValue: () => [model], useSetAtom: () => () => {} });
stub("src/features/setup/Setup.store", {
  setupModelsAtom: jotai.atom([]),
  setupProfilesAtom: jotai.atom([]),
  setupSketchPlaneAtom: jotai.atom(null),
});
stub("src/features/setup/rendering/overlayConstants", { COLOR_HOVERED: 0, COLOR_SELECTED: 0 });
(globalThis as Record<string, unknown>).window = {
  crypto: { randomUUID: () => "uuid" },
  // 애드온 없는 기본 설치 — Pad 는 Three.js 폴백으로 만든다
  electron: { ipcRenderer: { invoke: async () => { throw new Error("native addon 없음"); } } },
};

const disk: SerializedGeometry = { type: "circle", id: "disk", cx: 0, cy: 0, r: 5 };
const geometries = new Map([[disk.id, disk]]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0)); // 비동기 addExtrudedSolid 대기

async function createSession() {
  const { SketchPlaneManager } = await import("src/features/setup/rendering/SketchPlaneManager");
  const { BakedSketchManager } = await import("src/features/setup/rendering/BakedSketchManager");
  const { SolidOperationManager } = await import("src/features/setup/rendering/SolidOperationManager");
  const scene = new THREE.Scene();
  const planes = new SketchPlaneManager(scene, {} as never, {} as never, new THREE.Raycaster());
  const renderer = { domElement: { clientWidth: 100, clientHeight: 100 } } as unknown as THREE.WebGLRenderer;
  const baked = new BakedSketchManager(scene, renderer, (plane?: SketchPlane) => planes.getPlaneKey(plane));
  const solids = new SolidOperationManager(scene, (key) => baked.getSavedSketchByKey(key));
  // SetupScene.setupSketchPlane 과 같은 규칙: modelId 가 오면 그 모델 오프셋을 origin 에 더한다
  const setupSketchPlane = (plane: SketchPlane, modelId?: string) =>
    planes.setupSketchPlane(plane, modelId ? OFFSET : new THREE.Vector3());
  const sceneForHook = {
    getModelOffset: () => OFFSET,
    highlightFace: () => {},
    hideSectionPreview: () => {},
    setupSketchPlane,
  };
  return { planes, baked, solids, setupSketchPlane, sceneForHook };
}

/** 면 클릭 → 스케치 → 닫기(bake) → 스케치 우클릭 Pad (SetupCanvas.handleFacePick·handleCloseSketch, setup/index.tsx) */
async function sketchOnFaceAndPad() {
  const { useCrossSectionMode } = await import("src/features/setup/hooks/useCrossSectionMode");
  const session = await createSession();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  const { applyCrossSection } = useCrossSectionMode({ getScene: () => session.sceneForHook as never });
  const plane = applyCrossSection(model.id, { type: "face", faceGroupId: 0 })!;
  const planeKey = session.planes.getPlaneKey(plane)!; // SpecTree entry·viewState 의 키
  session.baked.bakeSketch(plane, [disk]);
  session.planes.clearSketchPlane();
  const pad: PadPocketOperation = {
    id: "pad", type: "pad", sketchPlaneKey: planeKey, profileIds: [], depth: 10, direction: "normal",
  };
  await session.solids.addExtrudedSolid(pad, geometries);
  const mesh = session.solids.extrudedSolids.get("pad") as THREE.Mesh;
  mesh.geometry.computeBoundingBox();
  return { session, planeKey, pad, box: mesh.geometry.boundingBox! };
}

/** 파일 다시 열기 — SetupCanvas 의 pendingRestore 처리와 같은 순서 */
async function reopen(sketches: SerializedSketch[], operations: OperationTreeEntry[]) {
  const session = await createSession();
  for (const sketch of sketches) {
    session.baked.restoreSavedSketch(session.planes.getPlaneKey(sketch.plane)!, sketch);
  }
  for (const entry of operations) {
    session.solids.rebuildOperationsForSketch(entry.operation.sketchPlaneKey, operations);
  }
  await settle();
  return session;
}

test("STEP 면 스케치로 만든 Pad 를 저장했다 다시 열면 같은 자리에 다시 만든다", async () => {
  // 고치기 전에는 bake 키를 오프셋 전 로컬 plane 으로, 저장 plane 은 오프셋을 더한 월드 좌표로 만들어,
  // 다시 열 때 복원 키(월드)와 Pad 의 sketchPlaneKey(로컬)가 어긋나 Pad 가 조용히 사라졌다
  const { session, pad, box } = await sketchOnFaceAndPad();
  // 면은 모델 좌표 y=50, 오프셋 -20 을 더해 화면(world) y=30 에 있다. Pad 는 그 위로 10 만큼 선다.
  assert.ok(Math.abs(box.min.y - 30) < 1e-6 && Math.abs(box.max.y - 40) < 1e-6, `Pad y 범위 ${box.min.y}..${box.max.y}`);
  const saved = [...session.baked.savedSketches.values()];
  const reopened = await reopen(saved, [{ operation: pad, sketchPlaneName: "Sketch 1" }]);
  const mesh = reopened.solids.extrudedSolids.get("pad");
  assert.ok(mesh instanceof THREE.Mesh, "다시 연 파일에서 Pad 가 다시 만들어져야 한다");
  mesh.geometry.computeBoundingBox();
  assert.ok(mesh.geometry.boundingBox!.equals(box), "Pad 가 저장 전과 같은 자리에 있어야 한다");
});

test("SpecTree 에서 면 스케치를 다시 편집하고 닫아도 스케치가 하나로 남는다", async () => {
  // 고치기 전에는 저장 plane(월드)으로 다시 들어가 닫으면 월드 키로 새 entry 가 생겨, 수정이 Pad 에 반영되지 않았다
  const { session, planeKey } = await sketchOnFaceAndPad();
  // SetupCanvas.handleEnterSketchByKey → handleCloseSketch
  const saved = session.baked.getSavedSketchByKey(planeKey)!;
  session.setupSketchPlane(saved.plane);
  session.baked.bakeSketch(saved.plane, [{ ...disk, r: 6 }]);
  assert.deepEqual([...session.baked.savedSketches.keys()], [planeKey]);
  const edited = session.baked.getSavedSketchByKey(planeKey)!.geometries![0];
  assert.equal(edited.type === "circle" ? edited.r : null, 6);
});

// 고치기 전 코드가 저장한 파일: 스케치 plane 은 월드, Pad 키·shape 키는 오프셋 전 로컬 origin
const n = { x: 0, y: 1, z: 0 };
const worldPlane: SketchPlane = { origin: { x: 0, y: 30, z: 0 }, normal: n, u: { x: 0, y: 0, z: -1 }, v: { x: -1, y: 0, z: 0 } };
const legacyLocalKey = "110,50,210|0,1,0";
const worldKey = "0,30,0|0,1,0";
const legacySketch: SerializedSketch = {
  plane: worldPlane,
  geometries: [disk],
  shapes: [{ id: "s1", lineIds: ["disk"], planeKey: legacyLocalKey, baseAngle: 0, holes: [], vertices: [] }],
};
const legacyPad: PadPocketOperation = {
  id: "pad", type: "pad", sketchPlaneKey: legacyLocalKey, profileIds: [], depth: 10, direction: "normal",
};

test("고치기 전에 저장한 파일도 열 때 Pad 키를 월드 키로 옮겨 Pad 를 다시 만든다", async () => {
  const { migrateLegacyFacePlaneKeys } = await import("src/features/setup/utils/legacyPlaneKeys");
  const operations = [{ operation: legacyPad, sketchPlaneName: "Sketch 1" }];
  const migrated = migrateLegacyFacePlaneKeys(
    operations,
    new Map([[worldKey, worldPlane]]),
    [new THREE.Vector3(5, 0, 5), OFFSET], // 로드된 모델들의 오프셋
  );
  assert.equal(migrated[0].operation.sketchPlaneKey, worldKey);
  assert.equal(legacyPad.sketchPlaneKey, legacyLocalKey, "원래 operation 객체는 바꾸지 않는다");
  const reopened = await reopen([legacySketch], migrated);
  assert.ok(reopened.solids.extrudedSolids.get("pad") instanceof THREE.Mesh);
});

test("오프셋이 맞는 스케치가 없거나 이미 맞는 키는 그대로 둔다", async () => {
  const { migrateLegacyFacePlaneKeys } = await import("src/features/setup/utils/legacyPlaneKeys");
  const orphan = [{ operation: legacyPad, sketchPlaneName: "Sketch 1" }];
  assert.equal(migrateLegacyFacePlaneKeys(orphan, new Map([[worldKey, worldPlane]]), [new THREE.Vector3(1, 2, 3)]), orphan);
  const current = [{ operation: { ...legacyPad, sketchPlaneKey: worldKey }, sketchPlaneName: "Sketch 1" }];
  assert.equal(migrateLegacyFacePlaneKeys(current, new Map([[worldKey, worldPlane]]), [OFFSET]), current);
});

test("다시 연 스케치의 shape 는 복원 키를 planeKey 로 가진다", async () => {
  // 고치기 전 파일의 shape.planeKey 는 로컬 키라, SpecTree 의 'Shapes [Sketch]' 묶음에서 빠졌다
  const reopened = await reopen([legacySketch], []);
  assert.equal(reopened.baked.getSavedSketchByKey(worldKey)!.shapes![0].planeKey, worldKey);
});
