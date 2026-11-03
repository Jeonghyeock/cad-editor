// B-Rep 엣지 투영 테스트가 같이 쓰는 평면·원형 엣지와 계산 도우미
import type { SerializedGeometry, SketchPlane, Vec3 } from "src/features/setup/Setup.type";
import type { BRepEdgeCurve } from "src/features/setup/step/BRepEdgeExtractor";

export type Circle = BRepEdgeCurve & { type: "circle" };
export type Arc = SerializedGeometry & { type: "arc" };

export const XY: SketchPlane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
};
// 같은 XY 평면을 아래에서 본 것. u×v 가 -Z 다
export const XY_FROM_BELOW: SketchPlane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: -1 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: -1, z: 0 },
};

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// 3D 원 위 매개변수 t 의 점 (OCCT 와 같이 yDir = axis × xDir)
export const circlePoint = (e: Circle, t: number): Vec3 => {
  const yd = cross(e.axis, e.xDir);
  const c = Math.cos(t) * e.radius, s = Math.sin(t) * e.radius;
  return {
    x: e.center.x + c * e.xDir.x + s * yd.x,
    y: e.center.y + c * e.xDir.y + s * yd.y,
    z: e.center.z + c * e.xDir.z + s * yd.z,
  };
};
export const toUV = (p: Vec3, plane: SketchPlane) => {
  const d = { x: p.x - plane.origin.x, y: p.y - plane.origin.y, z: p.z - plane.origin.z };
  return { x: dot(d, plane.u), y: dot(d, plane.v) };
};
// 스케치 호는 startAngle 에서 endAngle 까지 반시계로 그린다 (BakedSketchManager 와 같은 정규화)
export const sweepOf = (g: Arc) => {
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
export const FILLET_ARCS: Circle[] = [10, 0].flatMap((z) => [
  filletArc(2, 2, z, 1, Math.PI * 1.5, Math.PI * 2),
  filletArc(2, 8, z, -1, Math.PI / 2, Math.PI),
  filletArc(8, 2, z, -1, Math.PI * 1.5, Math.PI * 2),
  filletArc(8, 8, z, 1, Math.PI / 2, Math.PI),
]);
