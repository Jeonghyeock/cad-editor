import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { BRepEdgeCurve } from "src/features/setup/step/BRepEdgeExtractor";
import { projectBRepEdgesToSketch } from "src/features/setup/step/BRepEdgeProjector";

import { circlePoint, FILLET_ARCS, sweepOf, toUV, XY, XY_FROM_BELOW } from "./fixtures/brepEdges";
import type { Circle } from "./fixtures/brepEdges";

test("원 축이 스케치 법선과 반대인 필렛 호도 보각(270°)이 아닌 90° 호로 투영된다", () => {
  // 고치기 전에는 |axis·normal| 만 보아, 축이 반대인 호의 시작·끝이 2D 에서 시계 방향인데도 그대로 넣어 270° 가 됐다
  for (const plane of [XY, XY_FROM_BELOW]) {
    for (const edge of FILLET_ARCS) {
      const [g] = projectBRepEdgesToSketch([edge], plane);
      assert.ok(g.type === "arc");
      assert.ok(Math.abs(sweepOf(g) - Math.PI / 2) < 1e-9, `sweep ${sweepOf(g)}`);
      // 호 가운데가 3D 엣지 가운데를 투영한 점이다
      const mid = toUV(circlePoint(edge, (edge.startParam + edge.endParam) / 2), plane);
      const a = g.startAngle + sweepOf(g) / 2;
      assert.ok(Math.hypot(g.cx + g.r * Math.cos(a) - mid.x, g.cy + g.r * Math.sin(a) - mid.y) < 1e-9);
    }
  }
});

// 실제 opencascade.js 로 만든, X 축 방향으로 누운 원통(r=5, 길이 20)의 엣지: 양 끝 원과 이음선
const endCircle = (x: number): Circle => ({
  type: "circle",
  center: { x, y: 0, z: 0 },
  axis: { x: 1, y: 0, z: 0 },
  xDir: { x: 0, y: 0, z: 1 },
  radius: 5,
  startParam: 0,
  endParam: Math.PI * 2,
});
const LYING_SHAFT: BRepEdgeCurve[] = [
  endCircle(20),
  { type: "line", start: { x: 0, y: 1.2246467991473533e-15, z: 5 }, end: { x: 20, y: 1.2246467991473533e-15, z: 5 } },
  endCircle(0),
];

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
// 끝점 순서와 관계없이 (x1,y1)-(x2,y2) 선분인지
const isSegment = (g: SerializedGeometry, x1: number, y1: number, x2: number, y2: number) =>
  g.type === "line" &&
  ((near(g.x1, x1) && near(g.y1, y1) && near(g.x2, x2) && near(g.y2, y2)) ||
    (near(g.x1, x2) && near(g.y1, y2) && near(g.x2, x1) && near(g.y2, y1)));

test("스케치 평면과 수직인 전체 원은 빠지지 않고 지름만 한 선분으로 투영된다", () => {
  // 고치기 전에는 시작점과 끝점(전체 원이면 같은 점)만 이어 길이 0 으로 버려, 누운 샤프트의 양 끝 세로선이 없었다
  const geoms = projectBRepEdgesToSketch(LYING_SHAFT, XY);
  assert.equal(geoms.length, 3);
  assert.ok(geoms.some((g) => isSegment(g, 0, -5, 0, 5)));
  assert.ok(geoms.some((g) => isSegment(g, 20, -5, 20, 5)));
});

test("스케치 평면과 수직인 반원은 시작·끝이 아니라 실제로 닿는 범위의 선분이 된다", () => {
  // 시작(t=0)과 끝(t=π)이 같은 자리(y=0)로 투영되지만, 반원은 그 사이 y=-5 까지 간다
  const half: Circle = { ...endCircle(0), endParam: Math.PI };
  const [g] = projectBRepEdgesToSketch([half], XY);
  assert.ok(g && isSegment(g, 0, 0, 0, -5), JSON.stringify(g));
});
