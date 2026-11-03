import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry, SketchPlane, Vec3 } from "src/features/setup/Setup.type";
import type { BRepEdgeCurve } from "src/features/setup/step/BRepEdgeExtractor";
import { projectBRepEdgesToSketch } from "src/features/setup/step/BRepEdgeProjector";

type Circle = BRepEdgeCurve & { type: "circle" };
type Arc = SerializedGeometry & { type: "arc" };

const XY: SketchPlane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
};
// 같은 XY 평면을 아래에서 본 것. u×v 가 -Z 다
const XY_FROM_BELOW: SketchPlane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: -1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: -1, z: 0 },
};

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

// 3D 원 위 매개변수 t 의 점 (OCCT 와 같이 yDir = axis × xDir)
const circlePoint = (e: Circle, t: number): Vec3 => {
  const yd = cross(e.axis, e.xDir);
  const c = Math.cos(t) * e.radius, s = Math.sin(t) * e.radius;
  return {
    x: e.center.x + c * e.xDir.x + s * yd.x,
    y: e.center.y + c * e.xDir.y + s * yd.y,
    z: e.center.z + c * e.xDir.z + s * yd.z,
  };
};
const toUV = (p: Vec3, plane: SketchPlane) => {
  const d = { x: p.x - plane.origin.x, y: p.y - plane.origin.y, z: p.z - plane.origin.z };
  return { x: dot(d, plane.u), y: dot(d, plane.v) };
};
// 스케치 호는 startAngle 에서 endAngle 까지 반시계로 그린다 (BakedSketchManager 와 같은 정규화)
const sweepOf = (g: Arc) => {
  let sweep = g.endAngle - g.startAngle;
  if (sweep <= 0) sweep += Math.PI * 2;
  return sweep;
};

// 실제 opencascade.js 로 10×10×10 상자의 세로 모서리 4개에 r=2 필렛을 걸고 extractBRepEdges 로 뽑은 원형 엣지(윗면·아랫면).
// OCCT 는 xDir 을 모두 -Y 로 두고, 축을 +Z 인 것과 -Z 인 것으로 섞어 낸다.
const filletArc = (cx: number, cy: number, z: number, axisZ: number, t0: number, t1: number): Circle => ({
  type: "circle",
  center: { x: cx, y: cy, z },
  axis: { x: 0, y: 0, z: axisZ },
  xDir: { x: 0, y: -1, z: 0 },
  radius: 2,
  startParam: t0,
  endParam: t1,
});
const FILLET_ARCS: Circle[] = [10, 0].flatMap((z) => [
  filletArc(2, 2, z, 1, Math.PI * 1.5, Math.PI * 2),
  filletArc(2, 8, z, -1, Math.PI / 2, Math.PI),
  filletArc(8, 2, z, -1, Math.PI * 1.5, Math.PI * 2),
  filletArc(8, 8, z, 1, Math.PI / 2, Math.PI),
]);

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
