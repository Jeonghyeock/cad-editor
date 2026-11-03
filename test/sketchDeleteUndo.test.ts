import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchConstraintSolver } from "src/features/setup/sketch/constraints/SketchConstraintSolver";

// 스케치 store 는 구속 아이콘(svg)을 불러오고, 모듈을 읽을 때 Image 로 미리 받아 둔다.
// node 에는 둘 다 없으므로 파일 이름과 빈 Image 로 대신한 뒤 모듈은 동적 import 로 읽는다.
require.extensions[".svg"] = (module) => {
  module.exports = module.filename;
};
(globalThis as Record<string, unknown>).Image = class {
  src = "";
};

let solver: SketchConstraintSolver | null = null;

// 실제 store·구속 저장소·planegcs 솔버·통합 이력을 화면과 같은 방식으로 연결한다
async function createSketch() {
  const { SketchGeometryStore } = await import("src/features/setup/sketch/SketchGeometryStore");
  const { SketchConstraintStore } = await import("src/features/setup/sketch/constraints/SketchConstraintStore");
  const { SketchConstraintSolver } = await import("src/features/setup/sketch/constraints/SketchConstraintSolver");
  const { GlobalHistoryManager } = await import("src/features/setup/core/GlobalHistoryManager");
  if (!solver) {
    solver = new SketchConstraintSolver();
    await solver.init();
  }
  const store = new SketchGeometryStore();
  const constraints = new SketchConstraintStore();
  store.constraintStore = constraints;
  store.solver = solver;
  const history = new GlobalHistoryManager();
  history.setGeometryStore(store);
  store.globalHistory = history;
  return { store, constraints, history };
}

test("면으로 고른 원을 지우면 지름 치수도 함께 지우고, undo 하면 되살린다", async () => {
  const { store, constraints, history } = await createSketch();
  const { AddGeometryCommand } = await import("src/features/setup/sketch/commands/AddGeometryCommand");
  const { DeleteShapeCommand } = await import("src/features/setup/core/commands/DefinitionCommands");

  store.execute(new AddGeometryCommand({ type: "circle", id: "c1", cx: 0, cy: 0, r: 15 }));
  store.applyConstraint({ type: "diameter", id: "d1", circle: { geomId: "c1" }, value: 30 });

  history.executeCommand(new DeleteShapeCommand("shape_c1", store));
  assert.equal(store.geometries.has("c1"), false);
  assert.equal(constraints.constraints.has("d1"), false);

  // 고치기 전에는 지름이 고아로 남았다가, 다른 기하 명령을 undo 할 때 cleanOrphanConstraints 가 기록 없이 지웠다.
  // 그 뒤 Shape 삭제를 undo 하면 원만 돌아오고 치수는 영영 사라졌다.
  store.execute(new AddGeometryCommand({ type: "point", id: "p1", x: 50, y: 50 }));
  history.undo();
  history.undo();

  assert.equal(store.geometries.has("c1"), true);
  assert.equal(constraints.constraints.get("d1")?.type, "diameter");
});

test("면으로 고른 사각형을 지우면 바깥 선과의 평행 구속도 함께 지우고, undo 하면 되살린다", async () => {
  const { store, constraints, history } = await createSketch();
  const { AddGeometryCommand } = await import("src/features/setup/sketch/commands/AddGeometryCommand");
  const { AddRectangleCommand, createRectangleGeometryAndConstraints } = await import(
    "src/features/setup/sketch/commands/AddRectangleCommand"
  );
  const { DeleteShapeCommand } = await import("src/features/setup/core/commands/DefinitionCommands");

  const rect = createRectangleGeometryAndConstraints(0, 0, 60, 30, ["t", "r", "b", "l"]);
  store.execute(new AddRectangleCommand(rect.geometries, rect.constraints));
  store.execute(new AddGeometryCommand({ type: "line", id: "ext", x1: 0, y1: 80, x2: 40, y2: 100 }));
  store.applyConstraint({ type: "parallel", id: "par", lineA: { geomId: "ext" }, lineB: { geomId: "r" } });

  history.executeCommand(new DeleteShapeCommand("shape_b,l,r,t", store));
  assert.equal(constraints.constraints.has("par"), false);

  history.undo();
  assert.equal(store.geometries.has("r"), true);
  assert.equal(constraints.constraints.get("par")?.type, "parallel");
});
