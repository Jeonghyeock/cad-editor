import "./support/browserStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";
import { SnapEngine } from "src/features/setup/sketch/SnapEngine";

// 화면 반경 10px, 배율 1 → 스냅 반경 10, 공간 그리드 칸 크기 60(= 반경 × 6).
// 기하는 원점(항상 후보)과 축에서 멀리 두어 원점 스냅이 끼어들지 않게 한다.
const SCREEN_SNAP_RADIUS = 10;

function snapAt(geoms: SerializedGeometry[], x: number, y: number) {
  const store = new SketchGeometryStore();
  for (const g of geoms) store.geometries.set(g.id, g);
  return new SnapEngine().snap({ x, y }, 0, store, SCREEN_SNAP_RADIUS, 1);
}

test("긴 선의 몸통 위에서도 수선의 발 스냅이 잡힌다", () => {
  // 고치기 전에는 선을 AABB 중심·모서리 5점의 칸에만 넣어, 끝점·중점에서 먼 몸통 위(x=1100)에서는 후보에 오르지 않았다
  const line: SerializedGeometry = { type: "line", id: "L", x1: 1000, y1: 500, x2: 1400, y2: 500 };
  const r = snapAt([line], 1100, 503);
  assert.ok(r);
  assert.equal(r.type, "perpendicular");
  assert.equal(r.sourceGeomId, "L");
  assert.ok(Math.abs(r.x - 1100) < 1e-9 && Math.abs(r.y - 500) < 1e-9);

  // 대각선 위 어디서든(스냅 반경 안에서 선을 조금 비켜 서도) 그 선이 후보에 오른다.
  // 끝점·중점 둘레(선 길이의 2%)는 _snapToLineSegment 가 이산 스냅에 맡기려고 일부러 빼므로 건너뛴다.
  const diag: SerializedGeometry = { type: "line", id: "D", x1: 1000, y1: 1000, x2: 1500, y2: 1700 };
  const len = Math.hypot(500, 700);
  const nx = -700 / len, ny = 500 / len;
  for (let t = 0.03; t < 0.97; t += 0.01) {
    if (Math.abs(t - 0.5) < 0.03) continue;
    const off = ((t * 100) % 2 < 1 ? 1 : -1) * 8;
    const s = snapAt([diag], 1000 + 500 * t + nx * off, 1000 + 700 * t + ny * off);
    assert.ok(s && s.sourceGeomId === "D", `t=${t.toFixed(2)} 에서 대각선을 놓쳤다`);
  }
});

test("큰 원의 둘레에서 nearest·사분점 스냅이 잡힌다", () => {
  const circle: SerializedGeometry = { type: "circle", id: "C", cx: 2000, cy: 2000, r: 200 };
  // 30° 방향 둘레 바로 바깥 → 둘레 위 최근점
  const a = Math.PI / 6;
  const near = snapAt([circle], 2000 + 203 * Math.cos(a), 2000 + 203 * Math.sin(a));
  assert.ok(near);
  assert.equal(near.type, "nearest");
  assert.equal(near.sourceGeomId, "C");
  assert.ok(Math.abs(Math.hypot(near.x - 2000, near.y - 2000) - 200) < 1e-9);

  // 둘레 한 바퀴 어디서든 원이 후보에 오른다 (사분점 근처는 endpoint, 그 밖은 nearest)
  for (let deg = 0; deg < 360; deg += 3) {
    const t = (deg * Math.PI) / 180;
    const s = snapAt([circle], 2000 + 207 * Math.cos(t), 2000 + 207 * Math.sin(t));
    assert.ok(s && s.sourceGeomId === "C", `${deg}° 에서 원을 놓쳤다`);
  }

  // 오른쪽 사분점 근처
  const quad = snapAt([circle], 2203, 2002);
  assert.ok(quad);
  assert.equal(quad.type, "endpoint");
  assert.equal(quad.sourceGeomId, "C");
  assert.deepEqual({ x: quad.x, y: quad.y }, { x: 2200, y: 2000 });
});

test("두 긴 선이 끝점·중점에서 먼 곳에서 만나도 교차점 스냅이 잡힌다", () => {
  const h: SerializedGeometry = { type: "line", id: "H", x1: 1000, y1: 600, x2: 1400, y2: 600 };
  const v: SerializedGeometry = { type: "line", id: "V", x1: 1100, y1: 400, x2: 1100, y2: 1000 };
  const r = snapAt([h, v], 1102, 602);
  assert.ok(r);
  assert.equal(r.type, "intersection");
  assert.deepEqual({ x: r.x, y: r.y }, { x: 1100, y: 600 });
  assert.deepEqual(new Set([r.sourceGeomId, r.sourceGeomId2]), new Set(["H", "V"]));
});

test("호는 그려진 구간의 둘레에서만 잡히고, 칸이 너무 많이 필요한 큰 원도 빠지지 않는다", () => {
  // 위쪽 반원(0~π). 90° 둘레 근처는 잡히고, 그려지지 않은 아래쪽(270°)은 잡히지 않는다
  const arc: SerializedGeometry = { type: "arc", id: "A", cx: 3000, cy: 3000, r: 300, startAngle: 0, endAngle: Math.PI };
  const top = snapAt([arc], 3000 + 50, 3000 + 303);
  assert.ok(top);
  assert.equal(top.type, "nearest");
  assert.equal(top.sourceGeomId, "A");
  assert.equal(snapAt([arc], 3000 + 50, 3000 - 303), null);

  // 반지름 10만 원은 둘레를 칸마다 넣으면 수만 칸이라 따로 늘 후보로 둔다
  const big: SerializedGeometry = { type: "circle", id: "B", cx: 5000, cy: 5000, r: 100000 };
  const a = 1;
  const r = snapAt([big], 5000 + 100003 * Math.cos(a), 5000 + 100003 * Math.sin(a));
  assert.ok(r);
  assert.equal(r.type, "nearest");
  assert.equal(r.sourceGeomId, "B");
});
