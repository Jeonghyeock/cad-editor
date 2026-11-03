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
