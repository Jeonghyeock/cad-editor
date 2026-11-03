import "./support/browserStubs";

import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import type SetupScene from "src/features/setup/rendering/SetupScene";
import {
  REF_ORIGIN_ID,
  REF_X_AXIS_ID,
  SketchGeometryStore,
} from "src/features/setup/sketch/SketchGeometryStore";

// useDragController 를 React 없이 부른다. 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 대신할 모듈을 넣어 둔다.
// useCallback 은 함수를 그대로, useRef 는 평범한 { current } 객체를 돌려준다.
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};
stub("react", { ...React, useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }) });

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
