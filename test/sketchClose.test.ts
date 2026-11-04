import "./support/browserStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

// Sketch1 을 그려 둔 상태: 선 하나 + 길이 치수 + 닫힌 shape 하나
async function sketch1() {
  const { SketchGeometryStore, REF_ORIGIN_ID } = await import("src/features/setup/sketch/SketchGeometryStore");
  const { SketchConstraintStore } = await import("src/features/setup/sketch/constraints/SketchConstraintStore");
  const geoStore = new SketchGeometryStore();
  const constraintStore = new SketchConstraintStore();
  geoStore.constraintStore = constraintStore;
  geoStore.injectReferenceGeometry();
  geoStore.geometries.set("L1", { type: "line", id: "L1", x1: 0, y1: 0, x2: 40, y2: 0 });
  constraintStore.addConstraint({ type: "line_length", id: "len1", line: { geomId: "L1" }, value: 40 });
  geoStore.shapes = [{ id: "shape_L1", lineIds: ["L1"], planeKey: "xy", baseAngle: 0, holes: [], vertices: [] }];
  return { geoStore, constraintStore, REF_ORIGIN_ID };
}

test("스케치를 닫으면 그 스케치의 구속 저장소를 비운다", async () => {
  // 고치기 전에는 기하만 비우고 구속은 남겨, 다음 스케치의 저장 데이터·.cad·SpecTree 목록에 섞여 들어갔다
  const { clearClosedSketch } = await import("src/features/setup/sketch/sketchStoreReset");
  const { geoStore, constraintStore } = await sketch1();

  clearClosedSketch(geoStore, constraintStore);

  assert.equal(geoStore.geometries.size, 0);
  assert.equal(constraintStore.constraints.size, 0);
});

test("저장된 스케치가 없는 평면으로 들어가면 이전 스케치의 기하·shape·구속 없이 시작한다", async () => {
  // 고치기 전에는 참조 기하만 넣어, 아무것도 그리지 않고 닫으면 Sketch1 의 shape 가 유령 면으로 bake 됐다
  const { clearClosedSketch, startBlankSketch } = await import("src/features/setup/sketch/sketchStoreReset");
  const { geoStore, constraintStore, REF_ORIGIN_ID } = await sketch1();
  clearClosedSketch(geoStore, constraintStore);

  startBlankSketch(geoStore, constraintStore);

  assert.deepEqual(geoStore.serialize(), []);
  assert.deepEqual(geoStore.shapes, []);
  assert.deepEqual(constraintStore.serialize(), []);
  assert.ok(geoStore.geometries.has(REF_ORIGIN_ID));
});

test("새 스케치를 시작하면 SpecTree 목록이 다시 만들어지도록 기하·shape 버전을 올린 뒤 알린다", async () => {
  // SetupCanvas 의 렌더 리스너는 geometryVersion·shapeVersion 이 바뀔 때만 기하·shape·구속 목록을 다시 만든다.
  // 고치기 전에는 비우기만 하고 버전을 올리지 않아, SpecTree 가 이전 스케치의 shape 를 계속 보여 줬다.
  const { clearClosedSketch, startBlankSketch } = await import("src/features/setup/sketch/sketchStoreReset");
  const { geoStore, constraintStore } = await sketch1();
  clearClosedSketch(geoStore, constraintStore);
  const before = { geometry: geoStore.geometryVersion, shape: geoStore.shapeVersion };
  let seen = before;
  geoStore.addRenderListener(() => {
    seen = { geometry: geoStore.geometryVersion, shape: geoStore.shapeVersion };
  });

  startBlankSketch(geoStore, constraintStore);

  assert.notEqual(seen.geometry, before.geometry);
  assert.notEqual(seen.shape, before.shape);
});
