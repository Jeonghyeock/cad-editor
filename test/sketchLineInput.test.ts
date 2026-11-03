import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

import { createSketch, userGeometries } from "./sketchHarness";

const DEG = Math.PI / 180;

// 30° 선(base)과 (200,0) 중심 원(circ)이 있는 스케치
async function sketch(): Promise<SketchGeometryStore> {
  const store = await createSketch();
  store.geometries.set("base", { type: "line", id: "base", x1: 0, y1: 50, x2: 50 * Math.cos(30 * DEG), y2: 50 + 50 * Math.sin(30 * DEG) });
  store.geometries.set("circ", { type: "circle", id: "circ", cx: 200, cy: 0, r: 20 });
  return store;
}

async function drawWithInput(store: SketchGeometryStore, values: { L: number; A: number } | { H: number; V: number }) {
  const { LineDrawTool } = await import("src/features/setup/sketch/tools/LineDrawTool");
  const tool = new LineDrawTool();
  assert.ok(tool.applyInputValues(store, { H: 0, V: 0 }));
  assert.ok(tool.applyInputValues(store, values));
  const line = userGeometries(store, "line").find((g) => g.id !== "base");
  assert.ok(line, "선이 생겨야 한다");
  return line;
}

const constraintTypes = (store: SketchGeometryStore) => [...store.constraintStore!.constraints.values()].map((c) => c.type);

test("Line 에 L/A 를 입력하면 H/V 스냅이 각도를 바꾸지 않는다", async () => {
  // 고치기 전에는 L=100, A=2 가 0° 선 + horizontal 로 확정됐다
  const store = await sketch();
  const line = await drawWithInput(store, { L: 100, A: 2 });
  assert.ok(Math.abs(line.x2 - 100 * Math.cos(2 * DEG)) < 1e-6 && Math.abs(line.y2 - 100 * Math.sin(2 * DEG)) < 1e-6,
    `끝점 (${line.x2}, ${line.y2})`);
  assert.ok(!constraintTypes(store).includes("horizontal"));
});

test("Line 에 L/A 를 입력하면 평행 추론이 각도를 바꾸지 않는다", async () => {
  // 고치기 전에는 30° 선이 있을 때 L=50, A=33 이 30° + parallel 로 확정됐다
  const store = await sketch();
  const line = await drawWithInput(store, { L: 50, A: 33 });
  assert.ok(Math.abs(Math.atan2(line.y2 - line.y1, line.x2 - line.x1) - 33 * DEG) < 1e-9);
  assert.ok(Math.abs(Math.hypot(line.x2 - line.x1, line.y2 - line.y1) - 50) < 1e-9);
  assert.ok(!constraintTypes(store).includes("parallel"));
});

test("Line 에 끝점 H/V 를 입력해도 그 좌표 그대로 확정된다", async () => {
  const store = await sketch();
  const line = await drawWithInput(store, { H: 100, V: 2 });
  assert.deepEqual([line.x1, line.y1, line.x2, line.y2], [0, 0, 100, 2]);
  assert.ok(!constraintTypes(store).includes("horizontal"));
});

test("값 입력으로 찍은 점은 커서 위치의 스냅으로 자동 구속을 만들지 않는다", async () => {
  // 입력 중 커서가 원 근처에 있어 nearest 스냅이 잡혀 있어도, 입력한 끝점을 원에 붙이지 않는다
  const store = await sketch();
  store.snapResult = { type: "nearest", x: 220, y: 0, sourceGeomId: "circ", sourceGeomType: "circle" };
  const line = await drawWithInput(store, { L: 50, A: 33 });
  assert.ok(Math.abs(Math.hypot(line.x2, line.y2) - 50) < 1e-9);
  assert.deepEqual(constraintTypes(store), []);
});

test("마우스로 찍을 때는 여전히 H/V 스냅이 걸린다", async () => {
  const { LineDrawTool } = await import("src/features/setup/sketch/tools/LineDrawTool");
  const store = await sketch();
  const tool = new LineDrawTool();
  tool.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  tool.onPointerDown(store, { x: 100, y: 2 }, { x: 100, y: 2 });
  const line = userGeometries(store, "line").find((g) => g.id !== "base");
  assert.ok(line && Math.abs(line.y2) < 1e-9);
  assert.ok(constraintTypes(store).includes("horizontal"));
});
