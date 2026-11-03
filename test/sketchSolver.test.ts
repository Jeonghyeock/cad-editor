import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchConstraint } from "src/features/setup/sketch/constraints/SketchConstraint.type";

// 솔버가 불러오는 SketchGeometryStore → overlayConstants 가 svg 아이콘을 import 하고 Image 로 미리 읽는다.
// node 에는 둘 다 없으므로 svg 는 경로 문자열로, Image 는 아무것도 안 하는 객체로 대신한 뒤 솔버를 불러온다.
require.extensions[".svg"] = (m: NodeJS.Module, filename: string) => {
  m.exports = filename;
};
(globalThis as Record<string, unknown>).Image = class {
  src = "";
};

// 솔버는 구속 id·타입만으로 캐시를 고르므로, 경우마다 새 솔버로 푼다(실제 planegcs wasm).
async function solve(geometries: SerializedGeometry[], constraints: SketchConstraint[]) {
  const { SketchConstraintSolver } = await import("src/features/setup/sketch/constraints/SketchConstraintSolver");
  const solver = new SketchConstraintSolver();
  await solver.init();
  const geoms = new Map(geometries.map((g) => [g.id, g]));
  const result = solver.solve(geoms, new Map(constraints.map((c) => [c.id, c])));
  return { ...result, geoms };
}

const line = (id: string, x2: number, y2: number): SerializedGeometry => ({ type: "line", id, x1: 0, y1: 0, x2, y2 });
const lineDeg = (g: SerializedGeometry | undefined) => {
  assert.equal(g?.type, "line");
  if (g?.type !== "line") return NaN;
  return (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI;
};

// 원점에서 만나는 두 선 A(수평)·B 와 두 선 사이 각도 치수
const angleSketch = (bx: number, by: number, value: number): [SerializedGeometry[], SketchConstraint[]] => [
  [line("A", 10, 0), line("B", bx, by)],
  [
    { type: "coincident", id: "co", pointA: { geomId: "A", vertexIndex: 0 }, pointB: { geomId: "B", vertexIndex: 0 } },
    { type: "horizontal", id: "h", line: { geomId: "A" } },
    { type: "angle", id: "ang", lineA: { geomId: "A" }, lineB: { geomId: "B" }, value },
  ],
];

test("UI 가 받는 반사각(180°~360°) 각도 치수를 솔버가 맞추면 과구속으로 거부하지 않는다", async () => {
  // 고치기 전에는 planegcs 가 200° 를 -160° 로 맞춰도, 사후 검증이 acos 로 접은 160° 를 200·20 과만 비교해
  // over-constrained 로 판정했다. 새 치수는 참조로 바뀌고, 기존 치수를 고치면 스케치 전체가 빨개졌다.
  const reflex200 = await solve(...angleSketch(-10, 3, 200));
  assert.notEqual(reflex200.status, "over-constrained");
  assert.ok(Math.abs(lineDeg(reflex200.geoms.get("B")) - -160) < 1e-3);

  const reflex300 = await solve(...angleSketch(-10, -3, 300));
  assert.notEqual(reflex300.status, "over-constrained");
  assert.ok(Math.abs(lineDeg(reflex300.geoms.get("B")) - 60) < 1e-3);
});

test("180° 이하 각도 치수와 맞출 수 없는 각도 치수는 예전과 같이 판정한다", async () => {
  const acute = await solve(...angleSketch(10, 3, 30));
  assert.notEqual(acute.status, "over-constrained");
  assert.ok(Math.abs(lineDeg(acute.geoms.get("B")) - 30) < 1e-3);

  // 수평 + 수직인 두 선에 50° 는 맞출 수 없다
  const [geoms, constraints] = angleSketch(3, 10, 50);
  constraints.push({ type: "vertical", id: "v", line: { geomId: "B" } });
  assert.equal((await solve(geoms, constraints)).status, "over-constrained");
});

// 원점 중심 r=10 인 1/4 호
const arc = (r = 10): SerializedGeometry => ({ type: "arc", id: "R", cx: 0, cy: 0, r, startAngle: 0, endAngle: Math.PI / 2 });
const radius13: SketchConstraint = { type: "radius", id: "rad", circle: { geomId: "R" }, value: 13 };
const arcOf = (g: SerializedGeometry | undefined) => {
  assert.equal(g?.type, "arc");
  return g?.type === "arc" ? g : { cx: NaN, cy: NaN, r: NaN };
};
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ≠ ${expected}`);

test("호와 점 사이 거리 치수를 건 뒤 호 반지름을 바꿔도 거리 치수가 따라간다", async () => {
  // 고치기 전에는 호 거리를 '중심까지 r + 거리' 상수(빌드 시점 r=10)로 굳혀, 반지름 13 이 거부됐다
  const { status, geoms } = await solve(
    [arc(), { type: "point", id: "P", x: 15, y: 0 }],
    [
      { type: "point_circle_distance", id: "pd", point: { geomId: "P", vertexIndex: 0 }, circle: { geomId: "R" }, value: 5 },
      radius13,
    ],
  );
  assert.notEqual(status, "over-constrained");
  const r = arcOf(geoms.get("R"));
  const p = geoms.get("P");
  assert.equal(p?.type, "point");
  if (p?.type !== "point") return;
  near(r.r, 13);
  near(Math.hypot(p.x - r.cx, p.y - r.cy) - r.r, 5);
});

test("호와 선 사이 거리 치수를 건 뒤 호 반지름을 바꿔도 거리 치수가 따라간다", async () => {
  const { status, geoms } = await solve(
    [arc(), { type: "line", id: "L", x1: -20, y1: 20, x2: 20, y2: 20 }],
    [
      { type: "horizontal", id: "h", line: { geomId: "L" } },
      { type: "line_circle_distance", id: "ld", line: { geomId: "L" }, circle: { geomId: "R" }, value: 10 },
      radius13,
    ],
  );
  assert.notEqual(status, "over-constrained");
  const r = arcOf(geoms.get("R"));
  const l = geoms.get("L");
  assert.equal(l?.type, "line");
  if (l?.type !== "line") return;
  near(r.r, 13);
  near(Math.abs(l.y1 - r.cy) - r.r, 10);
});

test("호와 원 사이 거리 치수를 건 뒤 호 반지름을 바꿔도 거리 치수가 따라간다", async () => {
  const { status, geoms } = await solve(
    [arc(), { type: "circle", id: "K", cx: 30, cy: 0, r: 5 }],
    [
      { type: "circle_circle_distance", id: "cd", circleA: { geomId: "R" }, circleB: { geomId: "K" }, value: 15 },
      radius13,
    ],
  );
  assert.notEqual(status, "over-constrained");
  const r = arcOf(geoms.get("R"));
  const k = geoms.get("K");
  assert.equal(k?.type, "circle");
  if (k?.type !== "circle") return;
  near(r.r, 13);
  near(Math.hypot(k.cx - r.cx, k.cy - r.cy) - r.r - k.r, 15);
});

// 중심 C 에서 A·B 가 같은 거리(10)
const equidistantSketch = (): [SerializedGeometry[], SketchConstraint[]] => [
  [
    { type: "point", id: "A", x: 10, y: 0 },
    { type: "point", id: "B", x: 0, y: 10 },
    { type: "point", id: "C", x: 0, y: 0 },
  ],
  [
    {
      type: "equidistant", id: "eq",
      pointA: { geomId: "A", vertexIndex: 0 }, pointB: { geomId: "B", vertexIndex: 0 }, center: { geomId: "C", vertexIndex: 0 },
    },
  ],
];

test("equidistant 는 자유도를 하나만 쓰고, 모순 없는 거리 치수를 받아들인다", async () => {
  // 고치기 전에는 빌드 시점 거리(10)로 AC·BC 를 둘 다 고정해 자유도를 2 썼고, AC=12 를 거부했다
  const [geoms, constraints] = equidistantSketch();
  assert.equal((await solve(geoms, constraints)).dof, 6 - 1);

  const [geoms12, constraints12] = equidistantSketch();
  constraints12.push({
    type: "distance", id: "ac", pointA: { geomId: "A", vertexIndex: 0 }, pointB: { geomId: "C", vertexIndex: 0 }, value: 12,
  });
  const { status, geoms: solved } = await solve(geoms12, constraints12);
  assert.notEqual(status, "over-constrained");
  const [a, b, c] = ["A", "B", "C"].map((id) => solved.get(id));
  assert.ok(a?.type === "point" && b?.type === "point" && c?.type === "point");
  near(Math.hypot(a.x - c.x, a.y - c.y), 12);
  near(Math.hypot(b.x - c.x, b.y - c.y), 12);
});
