import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchConstraintSolver } from "src/features/setup/sketch/constraints/SketchConstraintSolver";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

// 스케치 store 는 구속 아이콘(svg)을 불러오고, 모듈을 읽을 때 Image 로 미리 받아 둔다.
// node 에는 둘 다 없으므로 파일 이름과 빈 Image 로 대신한 뒤 모듈은 동적 import 로 읽는다.
require.extensions[".svg"] = (module) => {
  module.exports = module.filename;
};
(globalThis as Record<string, unknown>).Image = class {
  src = "";
};

type Point = { x: number; y: number };
type Line = SerializedGeometry & { type: "line" };

let solver: SketchConstraintSolver | null = null;

// 실제 store·구속 저장소·planegcs 솔버·통합 이력을 화면과 같은 방식으로 연결한다
async function createSketch() {
  const { SketchGeometryStore } = await import("src/features/setup/sketch/SketchGeometryStore");
  const { SketchConstraintStore } = await import("src/features/setup/sketch/constraints/SketchConstraintStore");
  const { SketchConstraintSolver } = await import("src/features/setup/sketch/constraints/SketchConstraintSolver");
  const { GlobalHistoryManager } = await import("src/features/setup/core/GlobalHistoryManager");
  if (!solver) {
    solver = new SketchConstraintSolver();
    await solver.init();
  }
  const store = new SketchGeometryStore();
  const constraints = new SketchConstraintStore();
  store.constraintStore = constraints;
  store.solver = solver;
  const history = new GlobalHistoryManager();
  history.setGeometryStore(store);
  store.globalHistory = history;
  return { store, constraints };
}

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

// 도구가 새로 만든 기하 — 원본 선택 순서(t, r, b, l)와 같은 순서로 들어간다
function copiesOf(store: SketchGeometryStore, originalIds: string[]): SerializedGeometry[] {
  return [...store.geometries.values()].filter((g) => !originalIds.includes(g.id));
}

function directionConstraintsOf(store: SketchGeometryStore, geomId: string): string[] {
  return [...store.constraintStore!.constraints.values()]
    .filter((c) => (c.type === "horizontal" || c.type === "vertical") && c.line.geomId === geomId)
    .map((c) => c.type);
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

test("H/V 사각형을 30° 축으로 대칭 복제해도 복제본이 찌그러지지 않는다", async () => {
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
  for (const copy of copiesOf(store, RECT_IDS)) {
    assert.deepEqual(directionConstraintsOf(store, copy.id), []);
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
