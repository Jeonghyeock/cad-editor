import "./support/browserStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

import { createSketch } from "./helpers/sketch";

type Point = { x: number; y: number };
type Line = SerializedGeometry & { type: "line" };

// (20,10) 에서 시작하는 60×30 사각형(가로 변 horizontal, 세로 변 vertical)을 그려 전부 선택한다
const RECT_IDS: [string, string, string, string] = ["t", "r", "b", "l"];
async function drawRectangle(store: SketchGeometryStore) {
  const { AddRectangleCommand, createRectangleGeometryAndConstraints } = await import(
    "src/features/setup/sketch/commands/AddRectangleCommand"
  );
  const rect = createRectangleGeometryAndConstraints(20, 10, 60, 30, RECT_IDS);
  store.execute(new AddRectangleCommand(rect.geometries, rect.constraints));
  store.selectedIds = [...RECT_IDS];
}

// 도구가 새로 만든 기하(참조 기하 제외) — 원본 선택 순서(t, r, b, l)와 같은 순서로 들어간다
function copiesOf(store: SketchGeometryStore, originalIds: string[]): SerializedGeometry[] {
  return [...store.geometries.values()].filter(
    (g) => !originalIds.includes(g.id) && !("isReference" in g && g.isReference),
  );
}

function directionConstraintsOf(store: SketchGeometryStore, geomId: string): string[] {
  return [...store.constraintStore!.constraints.values()]
    .filter((c) => (c.type === "horizontal" || c.type === "vertical") && c.line.geomId === geomId)
    .map((c) => c.type);
}

function lineAnglesOf(store: SketchGeometryStore, geomId: string): number[] {
  return [...store.constraintStore!.constraints.values()].flatMap((c) =>
    c.type === "line_angle" && c.line.geomId === geomId ? [c.value] : [],
  );
}

function reflect(p: Point, a: Point, b: Point): Point {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const dot = (p.x - a.x) * ux + (p.y - a.y) * uy;
  return { x: 2 * (a.x + dot * ux) - p.x, y: 2 * (a.y + dot * uy) - p.y };
}

function assertNear(actual: Point, expected: Point, label: string) {
  assert.ok(
    Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-6,
    `${label}: (${actual.x}, ${actual.y}) 이어야 할 자리 (${expected.x}, ${expected.y})`,
  );
}

// 복제 선 하나하나가 원본 선의 대칭 위치에 그대로 있는지 본다(솔버가 옮기지 않았는지)
function assertMirroredInPlace(store: SketchGeometryStore, a: Point, b: Point) {
  const copies = copiesOf(store, RECT_IDS) as Line[];
  assert.equal(copies.length, 4);
  RECT_IDS.forEach((id, i) => {
    const original = store.geometries.get(id) as Line;
    assertNear({ x: copies[i].x1, y: copies[i].y1 }, reflect({ x: original.x1, y: original.y1 }, a, b), `${id} 복제 시작점`);
    assertNear({ x: copies[i].x2, y: copies[i].y2 }, reflect({ x: original.x2, y: original.y2 }, a, b), `${id} 복제 끝점`);
  });
}

test("H/V 사각형을 30° 축으로 대칭 복제해도 복제본이 찌그러지지 않고, 방향은 절대 각도로 고정된다", async () => {
  // 고치기 전에는 horizontal/vertical 을 그대로 복사해, 솔버가 복제본을 축에 다시 세우며 60×30 이 4.0×37.0 으로 찌그러졌다
  const { store } = await createSketch();
  const { MirrorDrawTool } = await import("src/features/setup/sketch/tools/MirrorDrawTool");
  await drawRectangle(store);

  const a = { x: 0, y: -100 };
  const b = { x: 200 * Math.cos(Math.PI / 6), y: -100 + 200 * Math.sin(Math.PI / 6) };
  const tool = new MirrorDrawTool();
  tool.onPointerDown(store, a, a);
  tool.onPointerDown(store, b, b);

  assertMirroredInPlace(store, a, b);
  assert.ok(store.solveStatus !== "over-constrained" && store.solveStatus !== "error", `solveStatus=${store.solveStatus}`);
  // 비스듬해진 복제 선은 H/V 대신 지금 방향의 절대 각도(line_angle)로 방향을 고정해, 원본과 같은 자유도를 지킨다
  for (const copy of copiesOf(store, RECT_IDS) as Line[]) {
    assert.deepEqual(directionConstraintsOf(store, copy.id), []);
    const angles = lineAnglesOf(store, copy.id);
    assert.equal(angles.length, 1, `${copy.id} 의 line_angle 개수`);
    const actual = (Math.atan2(copy.y2 - copy.y1, copy.x2 - copy.x1) * 180) / Math.PI;
    const diff = Math.abs((((angles[0] - actual) % 360) + 540) % 360 - 180);
    assert.ok(diff < 1e-6, `line_angle ${angles[0]}° 가 선 방향 ${actual}° 와 다르다`);
  }
});

test("축과 나란한 대칭·90° 회전 복제는 방향 구속을 결과 방향에 맞춰 옮긴다", async () => {
  const { MirrorDrawTool } = await import("src/features/setup/sketch/tools/MirrorDrawTool");
  const { RotateDrawTool } = await import("src/features/setup/sketch/tools/RotateDrawTool");

  // 세로 축 대칭: 가로 변은 그대로 가로
  {
    const { store } = await createSketch();
    await drawRectangle(store);
    const a = { x: 0, y: -100 }, b = { x: 0, y: 100 };
    const tool = new MirrorDrawTool();
    tool.onPointerDown(store, a, a);
    tool.onPointerDown(store, b, b);
    assertMirroredInPlace(store, a, b);
    const [top, right] = copiesOf(store, RECT_IDS);
    assert.deepEqual(directionConstraintsOf(store, top.id), ["horizontal"]);
    assert.deepEqual(directionConstraintsOf(store, right.id), ["vertical"]);
  }

  // 45° 축 대칭: 가로 변이 세로가 된다
  {
    const { store } = await createSketch();
    await drawRectangle(store);
    const a = { x: -100, y: -100 }, b = { x: 100, y: 100 };
    const tool = new MirrorDrawTool();
    tool.onPointerDown(store, a, a);
    tool.onPointerDown(store, b, b);
    assertMirroredInPlace(store, a, b);
    const [top, right] = copiesOf(store, RECT_IDS);
    assert.deepEqual(directionConstraintsOf(store, top.id), ["vertical"]);
    assert.deepEqual(directionConstraintsOf(store, right.id), ["horizontal"]);
  }

  // 원점 중심 90° 회전: 가로 변이 세로가 되고, 자리는 회전한 그대로
  {
    const { store } = await createSketch();
    await drawRectangle(store);
    const tool = new RotateDrawTool();
    for (const p of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]) tool.onPointerDown(store, p, p);
    const [top, right] = copiesOf(store, RECT_IDS) as Line[];
    assertNear({ x: top.x1, y: top.y1 }, { x: -10, y: 20 }, "회전한 윗변 시작점");
    assertNear({ x: top.x2, y: top.y2 }, { x: -10, y: 80 }, "회전한 윗변 끝점");
    assert.deepEqual(directionConstraintsOf(store, top.id), ["vertical"]);
    assert.deepEqual(directionConstraintsOf(store, right.id), ["horizontal"]);
  }
});

test("스케일 복제는 길이 치수 값도 배율만큼 바꿔, 복제본이 원래 크기로 돌아가지 않는다", async () => {
  // 고치기 전에는 line_length 를 옛 값으로 복사해, ×2 복제본을 솔버가 원래 길이로 되돌렸다
  const { store, constraints } = await createSketch();
  const { ScaleDrawTool } = await import("src/features/setup/sketch/tools/ScaleDrawTool");
  await drawRectangle(store);
  store.applyConstraint({ type: "line_length", id: "len_t", line: { geomId: "t" }, value: 60 });
  store.applyConstraint({ type: "line_length", id: "len_r", line: { geomId: "r" }, value: 30 });
  store.selectedIds = [...RECT_IDS];

  const tool = new ScaleDrawTool();
  for (const p of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]) tool.onPointerDown(store, p, p);

  const [top, right] = copiesOf(store, RECT_IDS) as Line[];
  assertNear({ x: top.x1, y: top.y1 }, { x: 40, y: 20 }, "두 배 한 윗변 시작점");
  assertNear({ x: top.x2, y: top.y2 }, { x: 160, y: 20 }, "두 배 한 윗변 끝점");
  assertNear({ x: right.x2, y: right.y2 }, { x: 160, y: 80 }, "두 배 한 오른변 끝점");
  const lengthOf = (geomId: string) => {
    const found = [...constraints.constraints.values()].find((c) => c.type === "line_length" && c.line.geomId === geomId);
    return found?.type === "line_length" ? found.value : undefined;
  };
  assert.equal(lengthOf(top.id), 120);
  assert.equal(lengthOf(right.id), 60);
});

test("호 끝점에 이은 선을 대칭 복제·대칭 이동해도 복제 선이 호의 반대쪽 끝으로 끌려가지 않는다", async () => {
  // 대칭은 호의 start/end 를 맞바꾼다. 고치기 전에는 coincident 의 호 vertexIndex(1=start, 2=end)를 그대로 복사해,
  // 복제 선이 (-70,0) 대신 호의 반대쪽 끝 (-50,20) 으로 당겨졌다
  const { AddGeometryCommand } = await import("src/features/setup/sketch/commands/AddGeometryCommand");
  const { MirrorDrawTool } = await import("src/features/setup/sketch/tools/MirrorDrawTool");
  const { SymmetryMoveDrawTool } = await import("src/features/setup/sketch/tools/SymmetryMoveDrawTool");
  const a = { x: 0, y: -100 }, b = { x: 0, y: 100 };

  for (const Tool of [MirrorDrawTool, SymmetryMoveDrawTool]) {
    const { store } = await createSketch();
    // 호: 중심 (50,0), 반지름 20, start (70,0) → end (50,20). 선은 호의 start 에서 시작한다
    store.execute(new AddGeometryCommand({ type: "arc", id: "arc", cx: 50, cy: 0, r: 20, startAngle: 0, endAngle: Math.PI / 2 }));
    store.execute(new AddGeometryCommand({ type: "line", id: "ln", x1: 70, y1: 0, x2: 90, y2: -30 }));
    store.applyConstraint({
      type: "coincident",
      id: "co",
      pointA: { geomId: "ln", vertexIndex: 0 },
      pointB: { geomId: "arc", vertexIndex: 1 },
    });
    store.selectedIds = ["arc", "ln"];

    const tool = new Tool();
    tool.onPointerDown(store, a, a);
    tool.onPointerDown(store, b, b);

    const [arcCopy, lineCopy] = copiesOf(store, ["arc", "ln"]);
    assert.equal(arcCopy.type, "arc");
    assert.equal(lineCopy.type, "line");
    if (arcCopy.type !== "arc" || lineCopy.type !== "line") return;
    assertNear({ x: arcCopy.cx, y: arcCopy.cy }, { x: -50, y: 0 }, `${Tool.name} 호 중심`);
    assertNear({ x: lineCopy.x1, y: lineCopy.y1 }, { x: -70, y: 0 }, `${Tool.name} 선 시작점`);
    assertNear({ x: lineCopy.x2, y: lineCopy.y2 }, { x: -90, y: -30 }, `${Tool.name} 선 끝점`);
  }
});
