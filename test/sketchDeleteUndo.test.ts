import assert from "node:assert/strict";
import { test } from "node:test";

import type { SketchConstraintSolver } from "src/features/setup/sketch/constraints/SketchConstraintSolver";
import type { SketchGeometryStore } from "src/features/setup/sketch/SketchGeometryStore";

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

// 이미지를 넣은 60×30 사각형(declared shape)을 만들고, 사용자가 바꾼 설정까지 걸어 둔다
async function insertImageRectangle(store: SketchGeometryStore) {
  const { InsertImageCommand } = await import("src/features/setup/sketch/commands/InsertImageCommand");
  const { createRectangleGeometryAndConstraints } = await import("src/features/setup/sketch/commands/AddRectangleCommand");
  const lineIds: [string, string, string, string] = ["t", "r", "b", "l"];
  const rect = createRectangleGeometryAndConstraints(0, 0, 60, 30, lineIds);
  store.execute(new InsertImageCommand(lineIds, rect.geometries, rect.constraints, IMAGE));
  const shape = store.shapes[0];
  shape.imageVisibility = false;
  shape.sceneIndex = 2;
  return shape.id;
}

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function assertImageShapeRestored(store: SketchGeometryStore, shapeId: string) {
  const restored = store.shapes.filter((s) => s.id === shapeId);
  assert.equal(restored.length, 1);
  const shape = restored[0];
  assert.equal(shape.origin, "declared");
  assert.equal(shape.image, IMAGE);
  assert.equal(shape.imageVisibility, false);
  assert.equal(shape.sceneIndex, 2);
}

test("이미지를 넣은 사각형의 변을 지우고 undo 하면 shape 의 이미지·설정까지 돌아온다", async () => {
  // 고치기 전에는 선·구속만 돌아오고 shape 는 origin:"detected", 이미지 없음으로 새로 만들어져 저장해도 이미지가 사라졌다
  const { store, history } = await createSketch();
  const shapeId = await insertImageRectangle(store);

  store.selectedIds = ["r"];
  store.deleteSelected();
  assert.equal(store.shapes.length, 0);

  history.undo();
  assertImageShapeRestored(store, shapeId);

  // redo 뒤 다시 undo 해도 같다
  history.redo();
  assert.equal(store.shapes.length, 0);
  history.undo();
  assertImageShapeRestored(store, shapeId);
});

test("이미지를 넣은 사각형의 변을 Trim 처럼 갈라 바꾸고 undo 하면 shape 의 이미지·설정까지 돌아온다", async () => {
  const { store, history } = await createSketch();
  const { CompoundSketchCommand } = await import("src/features/setup/sketch/commands/CompoundSketchCommand");
  const shapeId = await insertImageRectangle(store);

  // Trim 이 쓰는 형태: 원본 변을 지우고 조각 둘을 넣는다
  const right = store.geometries.get("r")!;
  store.execute(
    new CompoundSketchCommand(
      [right],
      [
        { type: "line", id: "r1", x1: 60, y1: 0, x2: 60, y2: 10 },
        { type: "line", id: "r2", x1: 60, y1: 20, x2: 60, y2: 30 },
      ],
      [],
      [],
    ),
  );
  assert.equal(store.shapes.some((s) => s.id === shapeId), false);

  history.undo();
  assertImageShapeRestored(store, shapeId);
});

test("변을 같이 쓰는 이웃 shape 를 면으로 지우고 undo 하면 남은 shape 의 이미지·설정까지 돌아온다", async () => {
  // 고치기 전에는 지운 shape 만 되돌려, 공유 변이 지워질 때 recomputeShapes 가 버린 이웃 shape 는 돌아오지 않았다
  const { store, history } = await createSketch();
  const { AddGeometryCommand } = await import("src/features/setup/sketch/commands/AddGeometryCommand");
  const { DeleteShapeCommand } = await import("src/features/setup/core/commands/DefinitionCommands");
  const imageShapeId = await insertImageRectangle(store);

  // 오른쪽에 붙은 사각형 — 이미지 사각형의 오른변 r 을 같이 쓴다
  store.execute(new AddGeometryCommand({ type: "line", id: "t2", x1: 60, y1: 0, x2: 120, y2: 0 }));
  store.execute(new AddGeometryCommand({ type: "line", id: "r2", x1: 120, y1: 0, x2: 120, y2: 30 }));
  store.execute(new AddGeometryCommand({ type: "line", id: "b2", x1: 120, y1: 30, x2: 60, y2: 30 }));
  const neighborId = store.registerShape(["r", "t2", "r2", "b2"]).id;

  history.executeCommand(new DeleteShapeCommand(neighborId, store));
  // 다른 기하 명령이 recomputeShapes 를 부르면, 오른변을 잃은 이미지 사각형이 버려진다
  store.execute(new AddGeometryCommand({ type: "point", id: "p1", x: 200, y: 200 }));
  assert.equal(store.shapes.some((s) => s.id === imageShapeId), false);

  history.undo();
  history.undo();
  store.recomputeFaces();
  assertImageShapeRestored(store, imageShapeId);
  assert.equal(store.shapes.filter((s) => s.id === neighborId).length, 1);
});
