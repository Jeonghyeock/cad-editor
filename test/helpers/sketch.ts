import { GlobalHistoryManager } from "src/features/setup/core/GlobalHistoryManager";
import type { SerializedGeometry } from "src/features/setup/Setup.type";
import { SketchConstraintSolver } from "src/features/setup/sketch/constraints/SketchConstraintSolver";
import { SketchConstraintStore } from "src/features/setup/sketch/constraints/SketchConstraintStore";
import { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

// 스케치 테스트가 같이 쓰는 준비물. SketchGeometryStore 가 아이콘 svg 를 불러오므로, 이 파일을 쓰는 테스트는
// "./support/browserStubs" 를 다른 import 보다 먼저 불러온다.

// 실제 planegcs 솔버를 붙인 스케치 store 와 통합 이력을 만든다. 앱의 createGeometryStoreBundle·SetupCanvas 연결과 같다.
// (Setup.store 를 불러오지 않으려고 연결을 여기서 다시 쓴다.) 이력은 열린 스케치의 명령만 기록하므로 "XY" 스케치를 연 상태로 둔다.
// 솔버는 구속 id·타입만으로 캐시를 고르므로 스케치마다 새로 만든다(init 은 수 ms 라 재사용하지 않는다).
export async function createSketch(history = new GlobalHistoryManager()) {
  history.setActiveSketch("XY");
  const store = new SketchGeometryStore();
  const constraints = new SketchConstraintStore();
  const solver = new SketchConstraintSolver();
  await solver.init();
  store.constraintStore = constraints;
  store.solver = solver;
  constraints.addMutationListener(() => solver.invalidateCache());
  history.setGeometryStore(store);
  store.globalHistory = history;
  store.injectReferenceGeometry();
  return { store, constraints, history };
}

export const line = (id: string, x1: number, y1: number, x2: number, y2: number): SerializedGeometry => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});

export function lineOf(store: SketchGeometryStore, id: string) {
  const g = store.geometries.get(id);
  if (g?.type !== "line") throw new Error(`${id} 는 선이 아니다`);
  return { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
}

export const round = (v: { x1: number; y1: number; x2: number; y2: number }) => ({
  x1: Math.round(v.x1 * 1000) / 1000,
  y1: Math.round(v.y1 * 1000) / 1000,
  x2: Math.round(v.x2 * 1000) / 1000,
  y2: Math.round(v.y2 * 1000) / 1000,
});

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
