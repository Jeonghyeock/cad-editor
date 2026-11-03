import "./support/browserStubs";

import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import type SetupScene from "src/features/setup/rendering/SetupScene";
import { SketchConstraintStore } from "src/features/setup/sketch/constraints/SketchConstraintStore";
import {
  REF_ORIGIN_ID,
  REF_X_AXIS_ID,
  SketchGeometryStore,
} from "src/features/setup/sketch/SketchGeometryStore";

// useDragController·useSketchPointerHandler 를 React 없이 부른다. 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에
// 대신할 모듈을 넣어 둔다. useCallback 은 함수를 그대로, useRef 는 평범한 { current } 객체를 돌려주고 useEffect 는 건너뛴다.
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};
stub("react", {
  ...React,
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
});
// 포인터 핸들러가 쓰는 화면 배율 계산만 필요하다(SetupScene 전체를 읽지 않도록). 배율 1 → 히트 반경 HIT_BUFFER.
stub("src/features/setup/hooks/useInputSceneController", { computeEngineScale: () => 1 });

async function setup(selectedIds: string[]) {
  const { useDragController } = await import("src/features/setup/hooks/useDragController");
  const store = new SketchGeometryStore();
  store.injectReferenceGeometry();
  store.geometries.set("L", { type: "line", id: "L", x1: 10, y1: 10, x2: 50, y2: 10 });
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  const drag = useDragController({} as SetupScene, { getGeometryStore: () => store });
  // 선 위를 눌러 본체 드래그를 시작한 상태 (useSketchPointerHandler 가 선택된 기하 전부를 ids 로 넣는다)
  drag.dragRef.current = {
    isDragging: false,
    startPos: { x: 20, y: 10 },
    lastPos: { x: 20, y: 10 },
    ids: selectedIds,
    vertexHandle: null,
    shapeId: null,
    geoSnapshot: null,
    fullSnapshot: null,
  };
  return { store, drag };
}

test("X 축과 선을 함께 선택해 드래그하면 선만 옮기고 축은 그대로 둔다", async () => {
  // 고치기 전에는 translateGeometry(axis) 가 undefined 를 돌려 축 자리에 undefined 가 저장되고, serialize() 가 깨졌다
  const { store, drag } = await setup([REF_X_AXIS_ID, "L"]);
  const axisBefore = structuredClone(store.geometries.get(REF_X_AXIS_ID));

  drag.handleDragMove({ x: 25, y: 13 });

  assert.deepEqual(store.geometries.get(REF_X_AXIS_ID), axisBefore);
  assert.deepEqual(store.geometries.get("L"), { type: "line", id: "L", x1: 15, y1: 13, x2: 55, y2: 13 });
  assert.doesNotThrow(() => store.serialize());
  assert.equal(drag.handleDragEnd({ x: 25, y: 13 }, {} as never), true);
});

test("원점과 선을 함께 선택해 드래그해도 원점은 (0,0) 에 남는다", async () => {
  const { store, drag } = await setup([REF_ORIGIN_ID, "L"]);

  drag.handleDragMove({ x: 25, y: 13 });

  const origin = store.geometries.get(REF_ORIGIN_ID);
  assert.ok(origin?.type === "point");
  assert.deepEqual({ x: origin.x, y: origin.y }, { x: 0, y: 0 });
  assert.deepEqual(store.geometries.get("L"), { type: "line", id: "L", x1: 15, y1: 13, x2: 55, y2: 13 });
});

test("원점과 coincident 인 꼭짓점을 끌다 쌍이 깨져 다시 적용해도 원점은 (0,0) 에 남는다", async () => {
  // 고치기 전에는 coincident 체인 전체(원점 포함)를 스냅샷에 넣어, 솔브 뒤 쌍이 깨졌을 때의 재적용 경로가
  // 원점까지 moveVertex 로 옮겼다
  const { useDragController } = await import("src/features/setup/hooks/useDragController");
  const store = new SketchGeometryStore();
  store.injectReferenceGeometry();
  store.geometries.set("L", { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 10 });
  store.constraintStore = new SketchConstraintStore();
  store.constraintStore.addConstraint({
    type: "coincident",
    id: "c1",
    pointA: { geomId: "L", vertexIndex: 0 },
    pointB: { geomId: REF_ORIGIN_ID, vertexIndex: 0 },
  });
  // 솔버가 쌍을 맞추지 못한 프레임(수렴 실패 등)을 흉내 낸다 — 그러면 꼭짓점만 움직여 쌍이 깨진 것으로 판정된다
  store.solveLive = () => {};
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  const drag = useDragController({} as SetupScene, { getGeometryStore: () => store });
  drag.dragRef.current = {
    isDragging: false,
    startPos: { x: 0, y: 0 },
    lastPos: { x: 0, y: 0 },
    ids: ["L"],
    vertexHandle: { geomId: "L", vertexIndex: 0, x: 0, y: 0 },
    shapeId: null,
    geoSnapshot: null,
    fullSnapshot: null,
  };

  drag.handleDragMove({ x: 5, y: 3 });

  const origin = store.geometries.get(REF_ORIGIN_ID);
  assert.ok(origin?.type === "point");
  assert.deepEqual({ x: origin.x, y: origin.y }, { x: 0, y: 0 });
});

test("X 축이 선택된 채 Ctrl+클릭한 원을 끌면 축은 드래그 대상이 아니라 원 하나의 크기 조절이 된다", async () => {
  // 고치기 전에는 선택된 기하 전부(축 포함)를 drag.ids 에 넣어, 원 하나만 끄는데도 ids.length 가 2 라
  // 크기 조절 대신 평행이동이 되었고 fixedKeys 도 참조 기하까지 셌다
  const { useDragController } = await import("src/features/setup/hooks/useDragController");
  const { useSketchPointerHandler } = await import("src/features/setup/hooks/useSketchPointerHandler");
  const store = new SketchGeometryStore();
  store.injectReferenceGeometry();
  store.geometries.set("C", { type: "circle", id: "C", cx: 100, cy: 100, r: 20 });
  store.selection = [{ kind: "geometry", geomId: REF_X_AXIS_ID }];

  let pointer = { x: 120, y: 100 }; // 원 둘레 위
  const scene = { raycastSketchPlane: () => pointer, getGeometryOverlay: () => null } as unknown as SetupScene;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  const drag = useDragController(scene, { getGeometryStore: () => store });
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  const pointerHandler = useSketchPointerHandler(scene, () => ({ x: 0, y: 0 }), {
    getGeometryStore: () => store,
    applySnap: (pos) => pos,
    setSketchWorldPos: () => {},
    getSnapInferenceRadius: () => 0,
    dragRef: drag.dragRef,
  });

  const ctrlDown = { button: 0, nativeEvent: { ctrlKey: true, metaKey: false } } as unknown as React.PointerEvent<HTMLCanvasElement>;
  pointerHandler.handleSketchPointerDown(ctrlDown);
  assert.deepEqual(store.selectedIds, [REF_X_AXIS_ID, "C"]);
  assert.deepEqual(drag.dragRef.current?.ids, ["C"]);

  pointer = { x: 130, y: 100 };
  drag.handleDragMove(pointer);
  assert.deepEqual(store.geometries.get("C"), { type: "circle", id: "C", cx: 100, cy: 100, r: 30 });
});
