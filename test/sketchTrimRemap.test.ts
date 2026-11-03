import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";
import { getConstraintGeomIds } from "src/features/setup/utils/geometryUtils";

import { createSketch, userGeometries } from "./sketchHarness";

type Point = { x: number; y: number };

// Trim 도구로 p 위치의 구간을 자른다(기본 rubber-in = 클릭한 구간 삭제). 마우스를 올린 뒤 클릭하는 순서를 따른다.
async function trimAt(store: SketchGeometryStore, p: Point) {
  const { TrimDrawTool } = await import("src/features/setup/sketch/tools/TrimDrawTool");
  const tool = new TrimDrawTool();
  tool.onPointerMove(store, p, p);
  assert.ok(tool.trimPreview, `(${p.x}, ${p.y}) 에서 자를 구간을 찾아야 한다`);
  tool.onPointerDown(store, p, p);
  tool.onPointerUp(store, p, p);
}

// 모든 구속이 지금 있는 기하만 가리키는지
function assertNoOrphans(store: SketchGeometryStore) {
  for (const c of store.constraintStore!.constraints.values()) {
    for (const id of getConstraintGeomIds(c)) {
      assert.ok(store.geometries.has(id), `${c.type}(${c.id}) 가 없는 기하 ${id} 를 가리킨다`);
    }
  }
}

const constraintsOf = (store: SketchGeometryStore, type: string) =>
  [...store.constraintStore!.constraints.values()].filter((c) => c.type === type);

test("지름 구속이 걸린 원을 Trim 하면 지름 구속이 남은 호로 옮겨 가고 고아로 남지 않는다", async () => {
  // 고치기 전에는 재매핑 switch 에 diameter 가 없어, 지워진 원 id 를 가리키는 고아 구속이 남았다
  const store = await createSketch();
  store.geometries.set("circ", { type: "circle", id: "circ", cx: 100, cy: 100, r: 20 });
  store.geometries.set("cut", { type: "line", id: "cut", x1: 70, y1: 100, x2: 130, y2: 100 });
  store.applyConstraint({ type: "diameter", id: "dia", circle: { geomId: "circ" }, value: 40 });

  await trimAt(store, { x: 100, y: 120 });

  const [arc] = userGeometries(store, "arc");
  assert.ok(arc, "아래쪽 반원이 남아야 한다");
  assert.ok(!store.geometries.has("circ"));
  assertNoOrphans(store);
  const dia = constraintsOf(store, "diameter");
  assert.equal(dia.length, 1);
  assert.deepEqual(getConstraintGeomIds(dia[0]), [arc.id]);
  assert.equal(store.solveStatus, "ok");

  // undo 하면 원과 원래 구속이 돌아온다
  store.globalHistory!.undo();
  assert.ok(store.geometries.has("circ"));
  assertNoOrphans(store);
  assert.deepEqual(constraintsOf(store, "diameter").map((c) => getConstraintGeomIds(c)), [["circ"]]);
});

test("선 양 끝을 잇는 수평 거리 구속은 Trim 뒤 양쪽 조각 끝점으로 옮겨 간다", async () => {
  const store = await createSketch();
  store.geometries.set("base", { type: "line", id: "base", x1: 0, y1: 50, x2: 100, y2: 50 });
  store.geometries.set("cutA", { type: "line", id: "cutA", x1: 30, y1: 30, x2: 30, y2: 70 });
  store.geometries.set("cutB", { type: "line", id: "cutB", x1: 70, y1: 30, x2: 70, y2: 70 });
  store.applyConstraint({
    type: "horizontal_distance", id: "hd", value: 100, sign: 1,
    pointA: { geomId: "base", vertexIndex: 0 }, pointB: { geomId: "base", vertexIndex: 1 },
  });

  await trimAt(store, { x: 50, y: 50 }); // 가운데 구간을 잘라 두 조각이 남는다

  assertNoOrphans(store);
  const [hd] = constraintsOf(store, "horizontal_distance");
  assert.ok(hd && hd.type === "horizontal_distance");
  const pieces = userGeometries(store, "line").filter((g) => g.y1 === 50 && g.y2 === 50);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.some((g) => g.id === hd.pointA.geomId && hd.pointA.vertexIndex === 0 && g.x1 === 0));
  assert.ok(pieces.some((g) => g.id === hd.pointB.geomId && hd.pointB.vertexIndex === 1 && g.x2 === 100));
});
