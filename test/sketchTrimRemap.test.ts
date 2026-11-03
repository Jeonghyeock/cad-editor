import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";
import { getConstraintGeomIds } from "src/features/setup/utils/geometryUtils";

import { createSketch, sweep, userGeometries } from "./sketchHarness";

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

const lengthOf = (g: { x1: number; y1: number; x2: number; y2: number }) => Math.hypot(g.x2 - g.x1, g.y2 - g.y1);

test("길이 치수가 걸린 선을 Trim 하면 치수는 길이가 바뀐 조각으로 옮겨 가지 않는다", async () => {
  // 고치기 전에는 line_length=100 이 60 짜리 조각으로 옮겨 가, 솔버가 조각을 다시 100 으로 늘려 자른 선을 또 넘었다
  const store = await createSketch();
  store.geometries.set("base", { type: "line", id: "base", x1: 10, y1: 50, x2: 110, y2: 50 });
  store.geometries.set("cut", { type: "line", id: "cut", x1: 50, y1: 30, x2: 50, y2: 70 });
  store.applyConstraint({ type: "line_length", id: "len", line: { geomId: "base" }, value: 100 });

  await trimAt(store, { x: 30, y: 50 });

  const piece = userGeometries(store, "line").find((g) => g.id !== "cut");
  assert.ok(piece);
  assert.ok(Math.abs(lengthOf(piece) - 60) < 1e-6, `조각 길이 ${lengthOf(piece)}`);
  assert.ok(Math.min(piece.x1, piece.x2) >= 50 - 1e-6);
  assert.deepEqual(constraintsOf(store, "line_length"), []);
  assertNoOrphans(store);

  // undo 하면 원래 선과 치수가 돌아온다
  store.globalHistory!.undo();
  assert.deepEqual(constraintsOf(store, "line_length").map((c) => getConstraintGeomIds(c)), [["base"]]);
});

test("치수를 넣은 100×60 사각형에 Fillet 을 걸어도 사각형 크기가 그대로다", async () => {
  // 고치기 전에는 잘린 변으로 옮겨 간 line_length 때문에 전체가 110×70 으로 커졌다
  const { RectangleDrawTool } = await import("src/features/setup/sketch/tools/RectangleDrawTool");
  const { FilletDrawTool } = await import("src/features/setup/sketch/tools/FilletDrawTool");
  const store = await createSketch();
  const rect = new RectangleDrawTool();
  rect.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  rect.onPointerDown(store, { x: 100, y: 60 }, { x: 100, y: 60 });
  const [edgeX, , , edgeY] = userGeometries(store, "line"); // (0,0)→(100,0), (0,60)→(0,0)
  store.applyConstraint({ type: "line_length", id: "w", line: { geomId: edgeX.id }, value: 100 });
  store.applyConstraint({ type: "line_length", id: "h", line: { geomId: edgeY.id }, value: 60 });

  const fillet = new FilletDrawTool();
  fillet.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  fillet.applyFillet(store, 10);

  assert.equal(store.solveStatus, "ok");
  const xs = userGeometries(store, "line").flatMap((g) => [g.x1, g.x2]);
  const ys = userGeometries(store, "line").flatMap((g) => [g.y1, g.y2]);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 100) < 1e-6, `가로 ${Math.max(...xs) - Math.min(...xs)}`);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 60) < 1e-6, `세로 ${Math.max(...ys) - Math.min(...ys)}`);
  assertNoOrphans(store);
});

test("equal·midpoint 도 길이가 바뀐 조각으로 옮겨 가지 않는다", async () => {
  const store = await createSketch();
  store.geometries.set("a", { type: "line", id: "a", x1: 10, y1: 50, x2: 110, y2: 50 });
  store.geometries.set("b", { type: "line", id: "b", x1: 10, y1: 90, x2: 110, y2: 90 });
  store.geometries.set("p", { type: "point", id: "p", x: 60, y: 50 });
  store.geometries.set("cut", { type: "line", id: "cut", x1: 50, y1: 30, x2: 50, y2: 70 });
  store.applyConstraint({ type: "equal", id: "eq", lineA: { geomId: "a" }, lineB: { geomId: "b" } });
  store.applyConstraint({ type: "midpoint", id: "mid", point: { geomId: "p", vertexIndex: 0 }, line: { geomId: "a" } });

  await trimAt(store, { x: 30, y: 50 });

  assert.deepEqual(constraintsOf(store, "equal"), []);
  assert.deepEqual(constraintsOf(store, "midpoint"), []);
  const b = store.geometries.get("b");
  assert.ok(b?.type === "line" && Math.abs(lengthOf(b) - 100) < 1e-6, "b 는 그대로 100 이다");
  const p = store.geometries.get("p");
  assert.ok(p?.type === "point" && Math.abs(p.x - 60) < 1e-6, "p 는 그대로 있다");
  assertNoOrphans(store);
});

test("길이가 그대로인 조각에는 길이 구속이 그대로 옮겨 간다(반원 보각)", async () => {
  const { ComplementDrawTool } = await import("src/features/setup/sketch/tools/ComplementDrawTool");
  const run = async (endAngle: number) => {
    const store = await createSketch();
    store.geometries.set("arc", { type: "arc", id: "arc", cx: 100, cy: 100, r: 20, startAngle: 0, endAngle });
    store.applyConstraint({ type: "arc_length", id: "al", arc: { geomId: "arc" }, value: 20 * endAngle });
    const hit = { x: 100 + 20 * Math.cos(endAngle / 2), y: 100 + 20 * Math.sin(endAngle / 2) };
    new ComplementDrawTool().onPointerDown(store, hit, hit);
    assert.ok(!store.geometries.has("arc"), "보각 호로 바뀌어야 한다");
    assertNoOrphans(store);
    return store;
  };
  // 180° 호의 보각도 180° — 호 길이 구속이 그대로 옮겨 간다
  const half = await run(Math.PI);
  assert.equal(constraintsOf(half, "arc_length").length, 1);
  // 90° 호의 보각은 270° — 옛 호 길이로 옮기면 솔버가 보각 호를 도로 줄이므로 옮기지 않는다
  const quarter = await run(Math.PI / 2);
  assert.deepEqual(constraintsOf(quarter, "arc_length"), []);
  const [arc] = userGeometries(quarter, "arc");
  assert.ok(Math.abs(sweep(arc) - 1.5 * Math.PI) < 1e-6, "보각 호가 270° 로 남아야 한다");
});
