import { GlobalHistoryManager } from "src/features/setup/core/GlobalHistoryManager";
import type { SerializedGeometry } from "src/features/setup/Setup.type";
import { SketchConstraintSolver } from "src/features/setup/sketch/constraints/SketchConstraintSolver";
import { SketchConstraintStore } from "src/features/setup/sketch/constraints/SketchConstraintStore";
import { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

// 실제 planegcs 솔버를 붙인 스케치 store 와 통합 이력을 만든다. 앱의 createGeometryStoreBundle·SetupCanvas 연결과 같다.
// (Setup.store 를 불러오지 않으려고 연결을 여기서 다시 쓴다.) 이력은 열린 스케치의 명령만 기록하므로 "XY" 스케치를 연 상태로 둔다.
export async function createSketch(history = new GlobalHistoryManager()) {
  history.setActiveSketch("XY");
  const store = new SketchGeometryStore();
  const constraintStore = new SketchConstraintStore();
  const solver = new SketchConstraintSolver();
  await solver.init();
  store.constraintStore = constraintStore;
  store.solver = solver;
  constraintStore.addMutationListener(() => solver.invalidateCache());
  history.setGeometryStore(store);
  store.globalHistory = history;
  store.injectReferenceGeometry();
  return { store, history };
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
