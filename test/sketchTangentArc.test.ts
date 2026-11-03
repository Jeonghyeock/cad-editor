import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";
import type { ProfileDrawTool } from "src/features/setup/sketch/tools/ProfileDrawTool";

import { createSketch, distance, sweep, userGeometries, vertexOf } from "./sketchHarness";

type Point = { x: number; y: number };
type Coincident = { type: "coincident"; pointA: { geomId: string; vertexIndex: number }; pointB: { geomId: string; vertexIndex: number } };

const coincidents = (store: SketchGeometryStore) =>
  [...store.constraintStore!.constraints.values()].filter((c): c is Extract<typeof c, Coincident> => c.type === "coincident");

// geomA 와 geomB 를 잇는 coincident 가 양쪽에서 가리키는 점
function joinPoints(store: SketchGeometryStore, idA: string, idB: string): [Point, Point] {
  const c = coincidents(store).find(
    (k) => (k.pointA.geomId === idA && k.pointB.geomId === idB) || (k.pointA.geomId === idB && k.pointB.geomId === idA),
  );
  assert.ok(c, `${idA} ↔ ${idB} coincident 가 있어야 한다`);
  const ref = (id: string) => (c.pointA.geomId === id ? c.pointA : c.pointB);
  return [vertexOf(store.geometries.get(idA), ref(idA).vertexIndex), vertexOf(store.geometries.get(idB), ref(idB).vertexIndex)];
}

// Profile 도구로 (0,0)→(10,0) 직선을 그린 상태. 클릭은 입력 패널 값(H/V)으로 넣어 더블클릭 판정을 피한다.
async function profileAfterLine(): Promise<{ store: SketchGeometryStore; tool: ProfileDrawTool }> {
  const { ProfileDrawTool } = await import("src/features/setup/sketch/tools/ProfileDrawTool");
  const store = await createSketch();
  const tool = new ProfileDrawTool();
  tool.applyInputValues(store, { H: 0, V: 0 });
  tool.applyInputValues(store, { H: 10, V: 0 });
  assert.equal(userGeometries(store, "line").length, 1);
  return { store, tool };
}

const lastDirection = (tool: ProfileDrawTool) => (tool as unknown as { _lastDirection: { dx: number; dy: number } })._lastDirection;

test("Profile 탄젠트 호를 오른쪽(시계 방향)으로 꺾어도 90° 호가 선 끝에서 이어지고, 다음 방향도 맞다", async () => {
  // 고치기 전에는 늘 CCW 로 만들어 +x 선 끝에서 (20,-10) 으로 그은 호가 sweep 270°, 시작 방향 (-1,0) 이었다
  const { store, tool } = await profileAfterLine();
  const [line] = userGeometries(store, "line");
  tool.profileMode = "tangent-arc";
  tool.applyInputValues(store, { H: 20, V: -10 });

  const [arc] = userGeometries(store, "arc");
  assert.ok(arc);
  assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6, `sweep ${(sweep(arc) * 180 / Math.PI).toFixed(1)}°`);
  assert.ok(distance({ x: arc.cx, y: arc.cy }, { x: 10, y: -10 }) < 1e-6, `중심 (${arc.cx}, ${arc.cy})`);
  assert.equal(store.solveStatus, "ok");
  const [onLine, onArc] = joinPoints(store, line.id, arc.id);
  assert.ok(distance(onLine, { x: 10, y: 0 }) < 1e-6 && distance(onArc, { x: 10, y: 0 }) < 1e-6);

  // 호 끝의 진행 방향은 (0,-1) 이고, 다음 세그먼트는 호의 (20,-10) 끝에서 이어진다
  const dir = lastDirection(tool);
  assert.ok(Math.abs(dir.dx) < 1e-6 && Math.abs(dir.dy + 1) < 1e-6, `방향 (${dir.dx}, ${dir.dy})`);
  tool.profileMode = "line";
  tool.applyInputValues(store, { H: 20, V: -30 });
  const next = userGeometries(store, "line").find((g) => g.id !== line.id);
  assert.ok(next);
  const [onArc2, onNext] = joinPoints(store, arc.id, next.id);
  assert.ok(distance(onArc2, { x: 20, y: -10 }) < 1e-6 && distance(onNext, { x: 20, y: -10 }) < 1e-6);
});

test("Profile 탄젠트 호를 왼쪽(CCW)으로 꺾는 경우는 그대로 90° 다", async () => {
  const { store, tool } = await profileAfterLine();
  const [line] = userGeometries(store, "line");
  tool.profileMode = "tangent-arc";
  tool.applyInputValues(store, { H: 20, V: 10 });

  const [arc] = userGeometries(store, "arc");
  assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6);
  const [, onArc] = joinPoints(store, line.id, arc.id);
  assert.ok(distance(onArc, { x: 10, y: 0 }) < 1e-6);
  const dir = lastDirection(tool);
  assert.ok(Math.abs(dir.dx) < 1e-6 && Math.abs(dir.dy - 1) < 1e-6, `방향 (${dir.dx}, ${dir.dy})`);
});

test("Profile 탄젠트 호 프리뷰도 90° 다", async () => {
  const { store, tool } = await profileAfterLine();
  tool.profileMode = "tangent-arc";
  tool.onPointerMove(store, { x: 20, y: -10 }, { x: 20, y: -10 });
  const preview = tool.preview;
  assert.ok(preview?.type === "arc");
  assert.ok(Math.abs(sweep(preview) - Math.PI / 2) < 1e-6, `sweep ${(sweep(preview) * 180 / Math.PI).toFixed(1)}°`);
});

test("Profile 3점 호를 시계 방향으로 그려도 선 끝에 붙는 쪽 호 끝점으로 잇는다", async () => {
  // 3점 호는 시계 방향이면 start/end 를 바꿔 두는데, 잇는 coincident 는 늘 vertex 1 이라 호의 반대쪽 끝이 선에 끌려갔다
  const { store, tool } = await profileAfterLine();
  const [line] = userGeometries(store, "line");
  tool.profileMode = "three-point-arc";
  const mid = { x: 10 + 10 * Math.SQRT1_2, y: -10 + 10 * Math.SQRT1_2 };
  tool.applyInputValues(store, { H: mid.x, V: mid.y });
  tool.applyInputValues(store, { H: 20, V: -10 });

  const [arc] = userGeometries(store, "arc");
  assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6);
  assert.equal(store.solveStatus, "ok");
  const [, onArc] = joinPoints(store, line.id, arc.id);
  assert.ok(distance(onArc, { x: 10, y: 0 }) < 1e-6, `호 쪽 점 (${onArc.x}, ${onArc.y})`);
  const dir = lastDirection(tool);
  assert.ok(Math.abs(dir.dx) < 1e-6 && Math.abs(dir.dy + 1) < 1e-6, `방향 (${dir.dx}, ${dir.dy})`);
});

// (-10,0)→(0,0) 선 A 와, (10,-10) 에서 아래로 내려가는 선 B 를 Connect(G1)로 잇는다 — 오른쪽으로 꺾이는 90° 호
async function connectRightTurn() {
  const { ConnectDrawTool } = await import("src/features/setup/sketch/tools/ConnectDrawTool");
  const store = await createSketch();
  const a: SerializedGeometry = { type: "line", id: "A", x1: -10, y1: 0, x2: 0, y2: 0 };
  const b: SerializedGeometry = { type: "line", id: "B", x1: 10, y1: -10, x2: 10, y2: -30 };
  store.geometries.set(a.id, a);
  store.geometries.set(b.id, b);
  const tool = new ConnectDrawTool();
  tool.continuityMode = "G1";
  store.snapResult = { type: "endpoint", x: 0, y: 0, sourceGeomId: "A", sourceVertexIndex: 1 };
  tool.onPointerDown(store, { x: 0, y: 0 }, { x: 0, y: 0 });
  store.snapResult = { type: "endpoint", x: 10, y: -10, sourceGeomId: "B", sourceVertexIndex: 0 };
  return { store, tool };
}

test("Connect G1 호가 오른쪽으로 꺾여도 90° 호로 두 선 끝을 잇는다", async () => {
  // 고치기 전에는 늘 CCW 로 만들어 270° 역방향 호가 생기고, 양 끝 coincident 도 반대 끝을 가리켰다
  const { store, tool } = await connectRightTurn();
  tool.onPointerMove(store, { x: 10, y: -10 }, { x: 10, y: -10 });
  const preview = tool.preview;
  assert.ok(preview?.type === "arc");
  assert.ok(Math.abs(sweep(preview) - Math.PI / 2) < 1e-6, `프리뷰 sweep ${(sweep(preview) * 180 / Math.PI).toFixed(1)}°`);

  tool.onPointerDown(store, { x: 10, y: -10 }, { x: 10, y: -10 });
  const [arc] = userGeometries(store, "arc");
  assert.ok(arc);
  assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6, `sweep ${(sweep(arc) * 180 / Math.PI).toFixed(1)}°`);
  assert.equal(store.solveStatus, "ok");
  const [onA, arcAtA] = joinPoints(store, "A", arc.id);
  assert.ok(distance(onA, { x: 0, y: 0 }) < 1e-6 && distance(arcAtA, { x: 0, y: 0 }) < 1e-6);
  const [onB, arcAtB] = joinPoints(store, "B", arc.id);
  assert.ok(distance(onB, { x: 10, y: -10 }) < 1e-6 && distance(arcAtB, { x: 10, y: -10 }) < 1e-6);
});

test("Profile 을 시계 방향 탄젠트 호로 닫아도 호가 바깥으로 돌고 시작점에서 닫힌다", async () => {
  const { ProfileDrawTool } = await import("src/features/setup/sketch/tools/ProfileDrawTool");
  const store = await createSketch();
  const tool = new ProfileDrawTool();
  // (0,0)→(0,10)→(10,10)→(10,0) 을 그린 뒤, 남쪽으로 내려가던 방향에서 오른쪽으로 꺾어 (0,0) 으로 닫는다
  for (const [H, V] of [[0, 0], [0, 10], [10, 10], [10, 0]]) tool.applyInputValues(store, { H, V });
  const [first] = userGeometries(store, "line");
  tool.profileMode = "tangent-arc";
  tool.applyInputValues(store, { H: 0, V: 0 });

  const [arc] = userGeometries(store, "arc");
  assert.ok(arc);
  const mid = arc.startAngle + sweep(arc) / 2;
  const midPoint = { x: arc.cx + arc.r * Math.cos(mid), y: arc.cy + arc.r * Math.sin(mid) };
  assert.ok(distance(midPoint, { x: 5, y: -5 }) < 1e-6, `호 가운데 (${midPoint.x}, ${midPoint.y})`);
  const [onFirst, onArc] = joinPoints(store, first.id, arc.id);
  assert.ok(distance(onFirst, { x: 0, y: 0 }) < 1e-6 && distance(onArc, { x: 0, y: 0 }) < 1e-6);
  assert.equal(store.solveStatus, "ok");
});

test("시계 방향 3점 호로 시작한 Profile 을 닫으면 닫는 coincident 가 체인 시작점에 붙는다", async () => {
  // 고치기 전에는 첫 세그먼트가 호면 시작을 늘 vertex 1 로 봐서, start/end 를 바꿔 둔 시계 방향 호에서는
  // 닫는 coincident 가 호의 반대쪽 끝((10,-10))에 붙었다
  const { ProfileDrawTool } = await import("src/features/setup/sketch/tools/ProfileDrawTool");
  const store = await createSketch();
  const tool = new ProfileDrawTool();
  tool.profileMode = "three-point-arc";
  // (0,0) 에서 중심 (0,-10) 원을 따라 시계 방향으로 (10,-10) 까지
  tool.applyInputValues(store, { H: 0, V: 0 });
  tool.applyInputValues(store, { H: 10 * Math.SQRT1_2, V: -10 + 10 * Math.SQRT1_2 });
  tool.applyInputValues(store, { H: 10, V: -10 });
  tool.profileMode = "line";
  tool.applyInputValues(store, { H: 0, V: -20 });
  tool.applyInputValues(store, { H: 0, V: 0 }); // 시작점 → 닫기

  const [arc] = userGeometries(store, "arc");
  assert.ok(Math.abs(sweep(arc) - Math.PI / 2) < 1e-6, `sweep ${(sweep(arc) * 180 / Math.PI).toFixed(1)}°`);
  const closing = userGeometries(store, "line").at(-1); // 마지막에 그린 닫는 선
  assert.ok(closing, "닫는 선이 있어야 한다");
  const [onClosing, onArc] = joinPoints(store, closing.id, arc.id);
  assert.ok(distance(onClosing, { x: 0, y: 0 }) < 1e-6 && distance(onArc, { x: 0, y: 0 }) < 1e-6,
    `닫는 선 (${onClosing.x}, ${onClosing.y}) / 호 (${onArc.x}, ${onArc.y})`);
  assert.equal(store.solveStatus, "ok");
  assert.equal(store.shapes.length, 1);
});
