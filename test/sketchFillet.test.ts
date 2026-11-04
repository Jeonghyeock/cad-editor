import "./support/browserStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

import { createSketch, distance, sweep, userGeometries, vertexOf } from "./helpers/sketch";

type Point = { x: number; y: number };
const CORNERS: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];

// (0,0)-(100,60) 사각형(Rectangle 도구로 그림)
async function rectangleSketch(): Promise<SketchGeometryStore> {
  const { RectangleDrawTool } = await import("src/features/setup/sketch/tools/RectangleDrawTool");
  const { store } = await createSketch();
  const rect = new RectangleDrawTool();
  rect.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  rect.onPointerDown(store, { x: 100, y: 60 }, { x: 100, y: 60 });
  assert.equal(userGeometries(store, "line").length, 4);
  return store;
}

async function filletTool(store: SketchGeometryStore, corner: Point, trimMode: "trim-all" | "no-trim" = "trim-all") {
  const { FilletDrawTool } = await import("src/features/setup/sketch/tools/FilletDrawTool");
  const tool = new FilletDrawTool();
  tool.trimMode = trimMode;
  tool.onPointerDown(store, corner, corner); // 꼭짓점 클릭 → 반경 입력 대기
  assert.ok(tool.pendingFillet, `(${corner.x}, ${corner.y}) 꼭짓점에서 두 선을 찾아야 한다`);
  return tool;
}

// 점에서 선분이 놓인 무한 직선까지 거리
function distanceToLine(p: Point, line: SerializedGeometry & { type: "line" }): number {
  const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
  return Math.abs(dx * (p.y - line.y1) - dy * (p.x - line.x1)) / Math.hypot(dx, dy);
}

test("사각형 네 꼭짓점 어디에 Fillet 을 걸어도 90° 호가 생기고 선 끝과 맞물린다", async () => {
  // 고치기 전에는 호의 start/end 를 선 순서대로 고정해 (0,0) 꼭짓점에서 270° 호(중심 (10,10))가 생겼다
  for (const corner of CORNERS) {
    const store = await rectangleSketch();
    const tool = await filletTool(store, corner);
    tool.applyFillet(store, 10);

    const arcs = userGeometries(store, "arc");
    assert.equal(arcs.length, 1);
    const arc = arcs[0];
    const label = `(${corner.x}, ${corner.y}) 꼭짓점`;
    assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6, `${label}: sweep ${(sweep(arc) * 180 / Math.PI).toFixed(1)}°`);
    assert.equal(store.solveStatus, "ok");
    const inward = { x: corner.x === 0 ? 10 : 90, y: corner.y === 0 ? 10 : 50 };
    assert.ok(distance({ x: arc.cx, y: arc.cy }, inward) < 1e-6, `${label}: 중심 (${arc.cx}, ${arc.cy})`);

    // 호와 잘린 선을 잇는 coincident 는 호의 같은 자리 끝점을 가리킨다
    const joins = [...store.constraintStore!.constraints.values()].filter(
      (c): c is Extract<typeof c, { type: "coincident" }> => c.type === "coincident" && c.pointB.geomId === arc.id,
    );
    assert.equal(joins.length, 2);
    assert.deepEqual(new Set(joins.map((c) => c.pointB.vertexIndex)), new Set([1, 2]));
    for (const c of joins) {
      const line = store.geometries.get(c.pointA.geomId);
      assert.ok(distance(vertexOf(line, c.pointA.vertexIndex), vertexOf(arc, c.pointB.vertexIndex)) < 1e-6, label);
    }
  }
});

test("Fillet 프리뷰 호도 90° 다", async () => {
  for (const corner of CORNERS) {
    const store = await rectangleSketch();
    const tool = await filletTool(store, corner);
    tool.computePreview(store, 10);
    const arc = tool.previews.find((g) => g.type === "arc");
    assert.ok(arc?.type === "arc");
    assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6, `(${corner.x}, ${corner.y}): ${(sweep(arc) * 180 / Math.PI).toFixed(1)}°`);
  }
});

test("no-trim 모드에서 선과 잇는 호 끝점은 그 선 위의 접점이다", async () => {
  for (const corner of CORNERS) {
    const store = await rectangleSketch();
    const tool = await filletTool(store, corner, "no-trim");
    const { line1, line2 } = tool.pendingFillet!;
    store.solver = null; // 구속이 가리키는 자리만 본다 — 풀기 전 좌표로 비교
    tool.applyFillet(store, 10);

    const arc = userGeometries(store, "arc")[0];
    assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6);
    for (const line of [line1, line2]) {
      const join = [...store.constraintStore!.constraints.values()].find(
        (c): c is Extract<typeof c, { type: "coincident" }> =>
          c.type === "coincident" && c.pointA.geomId === arc.id && c.pointB.geomId === line.id,
      );
      assert.ok(join);
      assert.ok(distanceToLine(vertexOf(arc, join.pointA.vertexIndex), line) < 1e-6, `(${corner.x}, ${corner.y}) ${line.id}`);
    }
  }
});
