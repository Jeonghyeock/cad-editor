import assert from "node:assert/strict";
import { test } from "node:test";

import type { Vec3 } from "src/features/setup/Setup.type";
import { projectBRepEdgesToSketch } from "src/features/setup/step/BRepEdgeProjector";

import { circlePoint, cross, dist3, FILLET_ARCS, sweepOf, XY } from "./fixtures/brepEdges";
import type { Circle } from "./fixtures/brepEdges";

// 네이티브 애드온(main 프로세스) 대신 IPC 에 답한다. 모듈이 불러올 때 window.electron 을 읽으므로 import 전에 둔다.
let rawEdges: unknown[] = [];
(globalThis as Record<string, unknown>).window = {
  electron: { ipcRenderer: { invoke: async () => rawEdges } },
};

// edge_extractor.cpp 의 extractCurve 가 원형 엣지에 대해 내보내는 모양: 실제 범위 [t0, t1] 을 32 등분한 33점과,
// t0·t0+s/3·t0+2s/3 세 점의 AB×AC 를 정규화한 hintAxis. 중심·반지름은 cpp 가 세 점에서 다시 구하는 값과 같다.
const nativeCircleEdge = (c: Circle) => {
  const sweep = c.endParam - c.startParam;
  const points = Array.from({ length: 33 }, (_, i) => circlePoint(c, c.startParam + (i / 32) * sweep));
  const a = circlePoint(c, c.startParam);
  const b = circlePoint(c, c.startParam + sweep / 3);
  const d = circlePoint(c, c.startParam + (sweep * 2) / 3);
  const sub = (p: Vec3, q: Vec3) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
  const n = cross(sub(b, a), sub(d, a));
  const len = Math.hypot(n.x, n.y, n.z);
  return {
    type: "other",
    points,
    curveHint: "circle",
    hintCenter: c.center,
    hintRadius: c.radius,
    hintAxis: { x: n.x / len, y: n.y / len, z: n.z / len },
    solidIndex: 0,
  };
};

const extract = async (circles: Circle[]) => {
  const { extractBRepEdgesNative } = await import("src/features/setup/step/BRepEdgeExtractorNative");
  rawEdges = circles.map(nativeCircleEdge);
  return (await extractBRepEdgesNative(1)) as Circle[];
};

test("네이티브 엣지 추출이 필렛 1/4 호를 전체 원이 아닌 실제 범위의 호로 바꾼다", async () => {
  // 고치기 전에는 원형 엣지를 모두 startParam 0, endParam 2π 로 만들어, 필렛마다 전체 원이 됐다
  const edges = await extract(FILLET_ARCS);
  edges.forEach((edge, i) => {
    const raw = nativeCircleEdge(FILLET_ARCS[i]);
    assert.equal(edge.type, "circle");
    assert.ok(Math.abs(edge.endParam - edge.startParam - Math.PI / 2) < 1e-9, `sweep ${edge.endParam - edge.startParam}`);
    // 시작·가운데·끝이 cpp 가 샘플한 점과 같다
    assert.ok(dist3(circlePoint(edge, edge.startParam), raw.points[0]) < 1e-9);
    assert.ok(dist3(circlePoint(edge, (edge.startParam + edge.endParam) / 2), raw.points[16]) < 1e-9);
    assert.ok(dist3(circlePoint(edge, edge.endParam), raw.points[32]) < 1e-9);
  });

  // Project 3D Edges 로 넣으면 필렛 자리에 90° 호 4개가 생긴다
  const arcs = projectBRepEdgesToSketch(edges, XY);
  assert.equal(arcs.length, 4);
  for (const g of arcs) {
    assert.ok(g.type === "arc");
    assert.ok(Math.abs(sweepOf(g) - Math.PI / 2) < 1e-9, `sweep ${sweepOf(g)}`);
  }
});

test("네이티브 엣지 추출이 구멍 같은 닫힌 원은 그대로 전체 원으로 둔다", async () => {
  const hole: Circle = { ...FILLET_ARCS[0], center: { x: 5, y: 5, z: 10 }, startParam: 0.3, endParam: 0.3 + Math.PI * 2 };
  const [edge] = await extract([hole]);
  assert.equal(edge.type, "circle");
  assert.equal(edge.endParam - edge.startParam, Math.PI * 2);
  const [g] = projectBRepEdgesToSketch([edge], XY);
  assert.ok(g.type === "circle");
  assert.ok(Math.abs(g.cx - 5) < 1e-9 && Math.abs(g.cy - 5) < 1e-9 && g.r === 2);
});

test("네이티브 엣지 추출이 2π 보다 아주 조금 짧은 주기 엣지도 닫힌 전체 원으로 둔다", async () => {
  // 첫 점과 끝 점이 r·1e-6 보다 조금 더 떨어지면, 고치기 전에는 0.001 rad 틈이 있는 호로 남아 와이어프레임에 틈이 보였다.
  // 투영(BRepEdgeProjector)이 전체 원으로 보는 기준(2π − 0.01)과 맞춘다
  const nearlyClosed: Circle = { ...FILLET_ARCS[0], startParam: 0, endParam: Math.PI * 2 - 0.001 };
  const [edge] = await extract([nearlyClosed]);
  assert.equal(edge.type, "circle");
  assert.equal(edge.endParam - edge.startParam, Math.PI * 2);
});
