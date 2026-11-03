import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchConstraint } from "src/features/setup/sketch/constraints/SketchConstraint.type";
import { detectClosedShapes } from "src/features/setup/sketch/shapeDetector";

type Seg = [id: string, x1: number, y1: number, x2: number, y2: number];

// 선분들과, 좌표가 같은 끝점끼리 잇는 coincident 구속(그리기 도구가 자동으로 거는 것과 같다)
function sketch(segs: Seg[], arcs: Extract<SerializedGeometry, { type: "arc" }>[] = []) {
  const geometries = new Map<string, SerializedGeometry>();
  for (const [id, x1, y1, x2, y2] of segs) geometries.set(id, { type: "line", id, x1, y1, x2, y2 });
  for (const arc of arcs) geometries.set(arc.id, arc);

  const ends: { geomId: string; vertexIndex: number; x: number; y: number }[] = [];
  for (const g of geometries.values()) {
    if (g.type === "line") {
      ends.push({ geomId: g.id, vertexIndex: 0, x: g.x1, y: g.y1 }, { geomId: g.id, vertexIndex: 1, x: g.x2, y: g.y2 });
    } else if (g.type === "arc") {
      for (const [vertexIndex, a] of [[1, g.startAngle], [2, g.endAngle]] as const) {
        ends.push({ geomId: g.id, vertexIndex, x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
      }
    }
  }
  const constraints = new Map<string, SketchConstraint>();
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (a.geomId === b.geomId || Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) continue;
      const id = `c${constraints.size}`;
      constraints.set(id, {
        type: "coincident", id,
        pointA: { geomId: a.geomId, vertexIndex: a.vertexIndex },
        pointB: { geomId: b.geomId, vertexIndex: b.vertexIndex },
      });
    }
  }
  return detectClosedShapes(geometries, constraints);
}

const faces = (shapes: ReturnType<typeof detectClosedShapes>) => shapes.map((s) => [...s.lineIds].sort().join(",")).sort();

const SQUARE: Seg[] = [["b", 0, 0, 10, 0], ["r", 10, 0, 10, 10], ["t", 10, 10, 0, 10], ["l", 0, 10, 0, 0]];

test("정사각형 하나는 면 하나다", () => {
  assert.deepEqual(faces(sketch(SQUARE)), ["b,l,r,t"]);
});

test("정사각형 꼭짓점에서 바깥으로 뻗은 가지 선은 면에 들어가지 않는다", () => {
  // 고치기 전에는 늘 가장 오른쪽으로 꺾어, 바깥 가지가 정사각형 면의 lineIds 에 섞였다
  assert.deepEqual(faces(sketch([...SQUARE, ["spur", 10, 0, 20, -5]])), ["b,l,r,t"]);
});

test("정사각형 꼭짓점에서 안쪽으로 뻗은 가지 선도 면에 들어가지 않는다", () => {
  assert.deepEqual(faces(sketch([...SQUARE, ["spur", 10, 0, 5, 5]])), ["b,l,r,t"]);
});

test("가로선으로 두 칸 나눈 사각형은 칸마다 면이 하나씩이다", () => {
  // 고치기 전에는 바깥 경계 하나만 잡혀 한 칸만 Pad 할 수 없었다
  const shapes = sketch([
    ["bottom", 0, 0, 100, 0], ["rLow", 100, 0, 100, 30], ["rUp", 100, 30, 100, 60], ["top", 100, 60, 0, 60],
    ["lUp", 0, 60, 0, 30], ["lLow", 0, 30, 0, 0], ["mid", 0, 30, 100, 30],
  ]);
  assert.deepEqual(faces(shapes), ["bottom,lLow,mid,rLow", "lUp,mid,rUp,top"]);
});

test("변을 공유하는 두 사각형은 면이 둘이다", () => {
  const shapes = sketch([
    ...SQUARE,
    ["b2", 10, 0, 20, 0], ["r2", 20, 0, 20, 10], ["t2", 20, 10, 10, 10],
  ]);
  assert.deepEqual(faces(shapes), ["b,l,r,t", "b2,r,r2,t2"]);
});

test("직선 둘과 호 둘로 된 슬롯은 면 하나다", () => {
  const shapes = sketch(
    [["low", 0, 0, 40, 0], ["up", 40, 20, 0, 20]],
    [
      { type: "arc", id: "right", cx: 40, cy: 10, r: 10, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 },
      { type: "arc", id: "left", cx: 0, cy: 10, r: 10, startAngle: Math.PI / 2, endAngle: Math.PI * 1.5 },
    ],
  );
  assert.deepEqual(faces(shapes), ["left,low,right,up"]);
});

test("열린 꺾은선은 면이 아니다", () => {
  // 왕복 면적은 0 이어야 하지만 부동소수 잔차로 작은 양수가 나와, 고치기 전에는 열린 꺾은선이 닫힌 면으로 잡히기도 했다
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 1000 - 500;
  for (let k = 0; k < 300; k++) {
    const p = Array.from({ length: 4 }, () => [rand(), rand()] as const);
    const segs: Seg[] = [0, 1, 2].map((i) => [`l${i}`, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]]);
    assert.deepEqual(faces(sketch(segs)), [], `꺾은선 ${k}`);
  }
});

test("다리 선으로 바깥 루프와 이어진 안쪽 루프는 다리 없이 둘 때처럼 바깥·안쪽 면이 따로다", async () => {
  // 최소 면을 돌게 고친 뒤 다리를 뺀 바깥·안쪽 루프 lineIds 가 한 shape 에 섞였다(그 전에는 안쪽 루프가 아예 빠졌다).
  // 안쪽 루프는 제 면으로 따로 잡히고, 돌출할 때 포함 깊이로 구멍이 된다(다리 없이 둘 때와 같은 표현)
  const { getShapeVerticesFromGeometries } = await import("src/features/setup/sketch/shapeDetector");
  const outer: Seg[] = [["o1", 0, 0, 100, 0], ["o2", 100, 0, 100, 100], ["o3", 100, 100, 0, 100], ["o4", 0, 100, 0, 0]];
  const inner: Seg[] = [["i1", 40, 40, 60, 40], ["i2", 60, 40, 60, 60], ["i3", 60, 60, 40, 60], ["i4", 40, 60, 40, 40]];
  const withBridge = sketch([...outer, ...inner, ["br", 0, 0, 40, 40]]);
  assert.deepEqual(faces(withBridge), faces(sketch([...outer, ...inner])));
  assert.deepEqual(faces(withBridge), ["i1,i2,i3,i4", "o1,o2,o3,o4"]);
  const geometries = new Map<string, SerializedGeometry>(
    [...outer, ...inner].map(([id, x1, y1, x2, y2]) => [id, { type: "line", id, x1, y1, x2, y2 }]),
  );
  for (const shape of withBridge) assert.equal(getShapeVerticesFromGeometries(shape, geometries).length, 4);
});

test("다리 선으로 이은 나란한 두 사각형은 각자 면이고 다리는 들어가지 않는다", () => {
  const shapes = sketch([
    ...SQUARE,
    ["b2", 30, 0, 40, 0], ["r2", 40, 0, 40, 10], ["t2", 40, 10, 30, 10], ["l2", 30, 10, 30, 0],
    ["br", 10, 0, 30, 0],
  ]);
  assert.deepEqual(faces(shapes), ["b,l,r,t", "b2,l2,r2,t2"]);
});

test("같은 현 위의 선과 호에 세 번째 변이 붙어도 면 경계는 geomId 가 아니라 실제 모양으로 정해진다", () => {
  // 고치기 전에는 호 반변의 각도를 현 방향으로 잡아 같은 현의 선과 각도가 같았고, 순서가 geomId 로 정해져
  // id 에 따라 사각형 면에 선 대신 아래로 볼록한 호가 들어갔다
  const rect: Seg[] = [["sideB", 10, 0, 10, 10], ["sideC", 10, 10, 0, 10], ["sideD", 0, 10, 0, 0]];
  // A(0,0)–B(10,0) 를 잇는 직선과, 같은 현 아래로 볼록한 반원(중심 (5,0), A 에서 CCW 로 B 까지)
  const bulge = (id: string) => ({ type: "arc" as const, id, cx: 5, cy: 0, r: 5, startAngle: Math.PI, endAngle: 0 });
  for (const [lineId, arcId] of [["chord", "a-bulge"], ["chord", "z-bulge"]]) {
    const shapes = sketch([...rect, [lineId, 0, 0, 10, 0]], [bulge(arcId)]);
    assert.ok(faces(shapes).includes(`${lineId},sideB,sideC,sideD`), `호 id ${arcId}: ${faces(shapes).join(" / ")}`);
    assert.ok(!faces(shapes).some((f) => f.split(",").includes(arcId) && f.split(",").includes("sideB")),
      `호 id ${arcId}: 사각형 면에 호가 섞였다 — ${faces(shapes).join(" / ")}`);
  }
});

test("선과 같은 접선으로 나가는 호도 휘는 방향으로 순서가 정해진다", () => {
  // 접선 각도만 보면 A(0,0) 에서 +x 로 나가는 선 AB 와 호 AE 의 각도가 같다 — 그때는 현이 왼쪽으로 휘는 쪽이 CCW 로 뒤다
  const square: Seg[] = [["ab", 0, 0, 10, 0], ["bc", 10, 0, 10, 10], ["cd", 10, 10, 0, 10], ["da", 0, 10, 0, 0], ["ec", 5, 5, 10, 10]];
  // 중심 (0,5) 반지름 5 — A 에서 +x 로 나가 E(5,5) 까지 CCW
  const arc = (id: string) => ({ type: "arc" as const, id, cx: 0, cy: 5, r: 5, startAngle: -Math.PI / 2, endAngle: 0 });
  for (const arcId of ["a-arc", "z-arc"]) {
    const shapes = sketch(square, [arc(arcId)]);
    assert.deepEqual(faces(shapes), [`${arcId},ab,bc,ec`, `${arcId},cd,da,ec`].map((f) => f.split(",").sort().join(",")).sort(),
      `호 id ${arcId}: ${faces(shapes).join(" / ")}`);
  }
});
