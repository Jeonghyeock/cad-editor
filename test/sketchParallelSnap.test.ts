import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

import { createSketch, distance, userGeometries } from "./sketchHarness";

type Point = { x: number; y: number };
type PpSnap = (store: SketchGeometryStore, start: Point, end: Point) => { pos: Point } | null;

const DEG = Math.PI / 180;
const at = (len: number, deg: number): Point => ({ x: len * Math.cos(deg * DEG), y: len * Math.sin(deg * DEG) });

// 30° 선 하나가 있는 스케치. 원점·축도 있다.
async function sketchWith30DegreeLine() {
  const store = await createSketch();
  const end = at(50, 30);
  store.geometries.set("base", { type: "line", id: "base", x1: 0, y1: 0, x2: end.x, y2: end.y });
  return store;
}

test("수직 추론이 걸린 선은 확정할 때 시작점 반대편으로 뒤집히지 않는다", async () => {
  // 고치기 전에는 JS % 의 음수 결과 때문에 (0,0)→(25,-43.30) 이 (-25,43.30) 으로 확정됐다
  const { LineDrawTool } = await import("src/features/setup/sketch/tools/LineDrawTool");
  const store = await sketchWith30DegreeLine();
  const tool = new LineDrawTool();
  const click = at(50, -60);
  tool.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  tool.onPointerDown(store, click, click);

  const line = userGeometries(store, "line").find((g) => g.id !== "base");
  assert.ok(line);
  assert.ok(distance({ x: line.x2, y: line.y2 }, click) < 1e-6, `끝점 (${line.x2}, ${line.y2})`);
  const constraints = [...store.constraintStore!.constraints.values()];
  assert.ok(constraints.some((c) => c.type === "perpendicular"));
});

test("평행·수직 추론은 어느 방향에서도 끝점을 임계각(5°) 넘게 돌리지 않는다", async () => {
  const { LineDrawTool } = await import("src/features/setup/sketch/tools/LineDrawTool");
  const tool = new LineDrawTool();
  const ppSnap = (tool as unknown as { _applyParallelPerpendicularSnap: PpSnap })._applyParallelPerpendicularSnap.bind(tool);

  let fired = 0;
  for (let baseDeg = -170; baseDeg <= 180; baseDeg += 10) {
    const store = await createSketch();
    store.removeReferenceGeometry(); // 축이 아니라 이 선에 걸리게 한다
    const b = at(40, baseDeg);
    store.geometries.set("base", { type: "line", id: "base", x1: 100, y1: 100, x2: 100 + b.x, y2: 100 + b.y });
    // 기준선 방향에서 0°·90°·180°·270° 근처(±3°)로 그은 선
    for (let k = 0; k < 4; k++) {
      for (const offset of [-3, 3]) {
        const raw = at(80, baseDeg + k * 90 + offset);
        const result = ppSnap(store, { x: 0, y: 0 }, raw);
        assert.ok(result, `기준 ${baseDeg}°, 방향 ${baseDeg + k * 90 + offset}° 에서 추론이 걸려야 한다`);
        fired++;
        const turned = Math.acos(Math.max(-1, Math.min(1, (raw.x * result.pos.x + raw.y * result.pos.y) / (80 * 80))));
        assert.ok(turned <= 5 * DEG + 1e-9, `기준 ${baseDeg}°, 방향 ${baseDeg + k * 90 + offset}° → ${(turned / DEG).toFixed(1)}° 돌아감`);
      }
    }
  }
  assert.equal(fired, 36 * 8);
});

test("Line 프리뷰는 확정될 위치(평행·수직 보정 후)를 보여 준다", async () => {
  const { LineDrawTool } = await import("src/features/setup/sketch/tools/LineDrawTool");
  const store = await sketchWith30DegreeLine();
  const tool = new LineDrawTool();
  const cursor = at(50, -58); // 30° 선과 88° — 수직 추론 범위 안
  tool.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  tool.onPointerMove(store, cursor, cursor);
  const preview = tool.preview;
  assert.ok(preview?.type === "line");
  tool.onPointerDown(store, cursor, cursor);

  const line = userGeometries(store, "line").find((g) => g.id !== "base");
  assert.ok(line);
  assert.ok(distance({ x: preview.x2, y: preview.y2 }, { x: line.x2, y: line.y2 }) < 1e-6,
    `프리뷰 (${preview.x2}, ${preview.y2}) / 확정 (${line.x2}, ${line.y2})`);
});

test("기울어진 사각형·평행사변형의 첫 변 프리뷰도 확정될 방향을 보여 준다", async () => {
  const { OrientedRectangleDrawTool } = await import("src/features/setup/sketch/tools/OrientedRectangleDrawTool");
  const { ParallelogramDrawTool } = await import("src/features/setup/sketch/tools/ParallelogramDrawTool");
  for (const Tool of [OrientedRectangleDrawTool, ParallelogramDrawTool]) {
    const store = await sketchWith30DegreeLine();
    const tool = new Tool();
    const cursor = at(50, -58);
    tool.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
    tool.onPointerMove(store, cursor, cursor);
    const preview = tool.previews[0];
    assert.ok(preview?.type === "line");
    tool.onPointerDown(store, cursor, cursor);
    const p2 = (tool as unknown as { _p2: Point })._p2;
    assert.ok(distance({ x: preview.x2, y: preview.y2 }, p2) < 1e-6,
      `${Tool.name}: 프리뷰 (${preview.x2}, ${preview.y2}) / 확정 (${p2.x}, ${p2.y})`);
  }
});

test("평행사변형의 두 번째 변 프리뷰도 확정될 방향을 보여 준다", async () => {
  const { ParallelogramDrawTool } = await import("src/features/setup/sketch/tools/ParallelogramDrawTool");
  const store = await sketchWith30DegreeLine();
  const tool = new ParallelogramDrawTool();
  const p2 = at(60, 10);
  tool.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  tool.onPointerDown(store, p2, p2);
  // 두 번째 변을 30° 선과 92° 로 — 수직 추론 범위 안
  const cursor = { x: p2.x + at(40, 122).x, y: p2.y + at(40, 122).y };
  tool.onPointerMove(store, cursor, cursor);
  const preview = tool.previews.find((g) => g.id === "__preview_1__");
  assert.ok(preview?.type === "line");
  tool.onPointerDown(store, cursor, cursor);

  const edge = userGeometries(store, "line").find((g) => distance({ x: g.x1, y: g.y1 }, p2) < 1e-6);
  assert.ok(edge);
  assert.ok(distance({ x: preview.x2, y: preview.y2 }, { x: edge.x2, y: edge.y2 }) < 1e-6,
    `프리뷰 (${preview.x2}, ${preview.y2}) / 확정 (${edge.x2}, ${edge.y2})`);
});
