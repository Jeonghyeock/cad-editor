import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry, StepModelData, Vec3 } from "src/features/setup/Setup.type";
import { polylineToGeometry, projectModelEdgesToSketch } from "src/features/setup/step/EdgeProjector";

import { XY } from "./fixtures/brepEdges";

// occt-import-js 가 내는 모양의 메시: B-Rep 면마다 자기 꼭짓점과 삼각형을 갖고, brepFaces 의 first/last 는 삼각형 번호다.
type Face = { verts: Vec3[]; tris: [number, number, number][] };

const model = (faces: Face[]): StepModelData => {
  const positions: number[] = [];
  const indices: number[] = [];
  const brepFaces: { first: number; last: number }[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const p of face.verts) positions.push(p.x, p.y, p.z);
    const first = indices.length / 3;
    for (const t of face.tris) indices.push(base + t[0], base + t[1], base + t[2]);
    brepFaces.push({ first, last: indices.length / 3 - 1 });
  }
  return {
    id: "m",
    fileName: "m.step",
    bodies: [{ name: "body", positions, normals: [], indices, brepFaces }],
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  };
};

const fan = (verts: Vec3[]): Face => ({
  verts,
  tris: verts.slice(2).map((_, i) => [0, i + 1, i + 2] as [number, number, number]),
});

// 바닥 다각형 poly 를 높이 h 로 세운 기둥. smoothSides 면 옆면 전체가 한 면(원통)이고, 이음선 꼭짓점은 따로 둔다
const prism = (poly: { x: number; y: number }[], h: number, smoothSides = false): Face[] => {
  const at = (p: { x: number; y: number }, z: number): Vec3 => ({ x: p.x, y: p.y, z });
  const faces = [fan(poly.map((p) => at(p, h))), fan(poly.map((p) => at(p, 0)).reverse())];
  const n = poly.length;
  if (smoothSides) {
    const ring = [...poly, poly[0]];
    const tris: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const top = i, bottom = n + 1 + i;
      tris.push([top, bottom, bottom + 1], [top, bottom + 1, top + 1]);
    }
    faces.push({ verts: [...ring.map((p) => at(p, h)), ...ring.map((p) => at(p, 0))], tris });
  } else {
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      faces.push({ verts: [at(a, 0), at(b, 0), at(b, h), at(a, h)], tris: [[0, 1, 2], [0, 2, 3]] });
    }
  }
  return faces;
};

const regular = (n: number, cx: number, cy: number, r: number) =>
  Array.from({ length: n }, (_, i) => ({
    x: cx + r * Math.cos((i / n) * Math.PI * 2),
    y: cy + r * Math.sin((i / n) * Math.PI * 2),
  }));

const circles = (geoms: SerializedGeometry[]) => geoms.filter((g) => g.type === "circle" || g.type === "arc");

test("메시 폴백 투영이 직사각형·삼각형·육각형 면 경계를 외접원으로 바꾸지 않는다", () => {
  // 고치기 전에는 꼭짓점만 원 위에 있는지 보아, 10×10 큐브 윗면이 r=7.071 원이 됐다
  const shapes = {
    cube: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    triangle: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8.660254 }],
    hexagon: regular(6, 5, 5, 5),
  };
  for (const [name, poly] of Object.entries(shapes)) {
    const geoms = projectModelEdgesToSketch(model(prism(poly, 10)), XY);
    assert.deepEqual(circles(geoms), [], name);
  }
});

test("메시 폴백 투영이 필렛 면(호를 갔다 되돌아오는 경계)을 전체 원으로 바꾸지 않는다", () => {
  // 세로 모서리 필렛(r=2, 중심 (2,2))의 1/4 원통 면. XY 로 투영하면 경계가 같은 호를 갔다가 되돌아온다
  const arc = Array.from({ length: 7 }, (_, i) => {
    const t = Math.PI + (i / 6) * (Math.PI / 2);
    return { x: 2 + 2 * Math.cos(t), y: 2 + 2 * Math.sin(t) };
  });
  const verts = [...arc.map((p) => ({ ...p, z: 10 })), ...arc.map((p) => ({ ...p, z: 0 }))];
  const tris: [number, number, number][] = [];
  for (let i = 0; i < 6; i++) tris.push([i, 7 + i, 8 + i], [i, 8 + i, i + 1]);
  const geoms = projectModelEdgesToSketch(model([{ verts, tris }]), XY);
  assert.deepEqual(geoms.filter((g) => g.type === "circle"), []);
});

test("메시 폴백 투영이 거칠게 테셀레이션된 구멍·원기둥은 그대로 원으로 둔다", () => {
  // occt-import-js 기본값으로 실측한 가장 거친 원: 10 m 판의 r=1 구멍이 10 등분(36°)
  const geoms = projectModelEdgesToSketch(model(prism(regular(10, 5, 5, 1), 10, true)), XY);
  assert.equal(geoms.length, 1, JSON.stringify(geoms));
  const [g] = geoms;
  assert.ok(g.type === "circle");
  assert.ok(Math.abs(g.cx - 5) < 1e-9 && Math.abs(g.cy - 5) < 1e-9 && Math.abs(g.r - 1) < 1e-9);
});

// 중심 (0,0), 반지름 5 원 위에서 각 deg[i](도) 의 점들
const onCircle = (degs: number[]) =>
  degs.map((d) => ({ x: 5 * Math.cos((d * Math.PI) / 180), y: 5 * Math.sin((d * Math.PI) / 180) }));
const arcSweep = (g: SerializedGeometry & { type: "arc" }) => {
  let sweep = g.endAngle - g.startAngle;
  if (sweep <= 0) sweep += Math.PI * 2;
  return sweep;
};

test("열린 경계가 시계 방향으로 돌아도 같은 90° 호가 된다 (보각 호가 아니다)", () => {
  // 스케치 호는 startAngle→endAngle 반시계다. 고치기 전에는 첫 점을 시작으로 고정해, 시계 방향 체인이 270° 호가 됐다
  for (const degs of [[0, 15, 30, 45, 60, 75, 90], [90, 75, 60, 45, 30, 15, 0]]) {
    const g = polylineToGeometry(onCircle(degs));
    assert.ok(g?.type === "arc", JSON.stringify(g));
    assert.ok(Math.abs(arcSweep(g) - Math.PI / 2) < 1e-9, `${degs}: sweep ${arcSweep(g)}`);
    assert.ok(Math.abs(Math.cos(g.startAngle) - 1) < 1e-9, `${degs}: start ${g.startAngle}`);
  }
});

test("같은 호를 갔다 되돌아오는 열린 경계는 호로 보지 않는다", () => {
  // 0° → 90° 를 갔다가 45° 로 되돌아온다. 고치기 전에는 첫·끝 점만 보아 0°~45° 호가 됐다
  const g = polylineToGeometry(onCircle([0, 15, 30, 45, 60, 75, 90, 75, 60, 45]));
  assert.notEqual(g?.type, "arc", JSON.stringify(g));
});
