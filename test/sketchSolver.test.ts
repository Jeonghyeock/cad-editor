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
