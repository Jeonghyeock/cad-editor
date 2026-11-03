// 스케치 도구 테스트가 같이 쓰는 준비물 — 실제 SketchGeometryStore·구속 저장소·planegcs 솔버·통합 이력을 node 에서 묶는다.
// 이 파일은 test/*.test.ts 에 걸리지 않아 혼자 실행되지 않는다.

import type { SerializedGeometry } from "src/features/setup/Setup.type";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

// SketchGeometryStore 가 불러오는 overlayConstants 는 아이콘(svg)을 읽고 Image 를 만들어 node 에서 읽을 수 없다.
// 쓰는 상수 하나만 담은 대체 모듈을 require 캐시에 넣어 둔다. 도구·저장소는 이 파일을 불러온 뒤 동적 import 로 읽는다.
const overlayConstants = require.resolve("src/features/setup/rendering/overlayConstants");
require.cache[overlayConstants] = {
  id: overlayConstants,
  filename: overlayConstants,
  loaded: true,
  exports: { AXIS_SCREEN_PX: 40 },
} as NodeJS.Module;

/** 앱과 같은 방식으로 저장소·구속 저장소·솔버·이력을 묶은 빈 스케치. 원점·축(참조 기하)도 넣는다. */
export async function createSketch(): Promise<SketchGeometryStore> {
  const { SketchGeometryStore } = await import("src/features/setup/sketch/SketchGeometryStore");
  const { SketchConstraintStore } = await import("src/features/setup/sketch/constraints/SketchConstraintStore");
  const { SketchConstraintSolver } = await import("src/features/setup/sketch/constraints/SketchConstraintSolver");
  const { GlobalHistoryManager } = await import("src/features/setup/core/GlobalHistoryManager");

  const store = new SketchGeometryStore();
  const constraintStore = new SketchConstraintStore();
  const solver = new SketchConstraintSolver();
  await solver.init();
  store.constraintStore = constraintStore;
  store.solver = solver;
  constraintStore.addMutationListener(() => solver.invalidateCache());
  const history = new GlobalHistoryManager();
  history.setGeometryStore(store);
  store.globalHistory = history;
  store.injectReferenceGeometry();
  return store;
}

type Point = { x: number; y: number };

/** 호가 startAngle 에서 CCW 로 endAngle 까지 쓸고 가는 각도 (0, 2π] */
export function sweep(arc: { startAngle: number; endAngle: number }): number {
  let s = arc.endAngle - arc.startAngle;
  while (s <= 0) s += Math.PI * 2;
  while (s > Math.PI * 2) s -= Math.PI * 2;
  return s;
}

/** 기하의 vertex 좌표 (line: 0 시작·1 끝, arc: 0 중심·1 시작·2 끝) */
export function vertexOf(geom: SerializedGeometry | undefined, vertexIndex: number): Point {
  if (geom?.type === "line") return vertexIndex === 0 ? { x: geom.x1, y: geom.y1 } : { x: geom.x2, y: geom.y2 };
  if (geom?.type === "arc") {
    if (vertexIndex === 0) return { x: geom.cx, y: geom.cy };
    const a = vertexIndex === 1 ? geom.startAngle : geom.endAngle;
    return { x: geom.cx + geom.r * Math.cos(a), y: geom.cy + geom.r * Math.sin(a) };
  }
  throw new Error(`vertex 를 구할 수 없는 기하: ${geom?.type}`);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 새로 생긴 기하만 (참조 기하 제외) 타입별로 */
export function userGeometries<T extends SerializedGeometry["type"]>(
  store: SketchGeometryStore,
  type: T,
): Extract<SerializedGeometry, { type: T }>[] {
  return [...store.geometries.values()].filter(
    (g): g is Extract<SerializedGeometry, { type: T }> => g.type === type && !("isReference" in g && g.isReference),
  );
}
