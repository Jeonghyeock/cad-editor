// 사각형 생성 커맨드: 4 line + 8 constraints (4 coincident + 2 horizontal + 2 vertical)
// 원자적 추가/취소 (undo 시 기하+구속 함께 제거)

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class AddRectangleCommand implements GeometryCommand {
  private _geometries: SerializedGeometry[];
  private _constraints: SketchConstraint[];

  constructor(geometries: SerializedGeometry[], constraints: SketchConstraint[]) {
    this._geometries = geometries;
    this._constraints = constraints;
  }

  execute(store: SketchGeometryStore): void {
    for (const geom of this._geometries) {
      store.geometries.set(geom.id, geom);
    }
    if (store.constraintStore) {
      store.constraintStore.addConstraints(this._constraints);
    }
    // closed loop → shape 직접 등록
    store.registerShape(this._geometries.map((g) => g.id));
  }

  undo(store: SketchGeometryStore): void {
    // shape 먼저 삭제
    store.unregisterShape(this._geometries.map((g) => g.id));
    for (const geom of this._geometries) {
      store.geometries.delete(geom.id);
      store.selectedIds = store.selectedIds.filter((id) => id !== geom.id);
      const h = store.hoveredItem;
      if (h && (h.kind === "geometry" || h.kind === "vertex") && h.geomId === geom.id) store.hoveredItem = null;
    }
    if (store.constraintStore) {
      store.constraintStore.removeConstraints(this._constraints.map((c) => c.id));
    }
  }
}

// 4개 line + 8개 constraint를 생성하는 헬퍼
export function createRectangleGeometryAndConstraints(
  x: number,
  y: number,
  w: number,
  h: number,
  lineIds: [string, string, string, string],
): { geometries: SerializedGeometry[]; constraints: SketchConstraint[] } {
  // 꼭짓점: TL(x,y) → TR(x+w,y) → BR(x+w,y+h) → BL(x,y+h)
  // line[0]: top     (TL → TR)
  // line[1]: right   (TR → BR)
  // line[2]: bottom  (BR → BL)
  // line[3]: left    (BL → TL)

  const geometries: SerializedGeometry[] = [
    { type: "line", id: lineIds[0], x1: x, y1: y, x2: x + w, y2: y },
    { type: "line", id: lineIds[1], x1: x + w, y1: y, x2: x + w, y2: y + h },
    { type: "line", id: lineIds[2], x1: x + w, y1: y + h, x2: x, y2: y + h },
    { type: "line", id: lineIds[3], x1: x, y1: y + h, x2: x, y2: y },
  ];

  let cIdx = 0;
  const cid = () => `cst_${lineIds[0]}_${cIdx++}`;

  // Coincident: line[i].end ≡ line[(i+1)%4].start
  const constraints: SketchConstraint[] = [
    // top.end(1) ≡ right.start(0)
    { type: "coincident", id: cid(), pointA: { geomId: lineIds[0], vertexIndex: 1 }, pointB: { geomId: lineIds[1], vertexIndex: 0 } },
    // right.end(1) ≡ bottom.start(0)
    { type: "coincident", id: cid(), pointA: { geomId: lineIds[1], vertexIndex: 1 }, pointB: { geomId: lineIds[2], vertexIndex: 0 } },
    // bottom.end(1) ≡ left.start(0)
    { type: "coincident", id: cid(), pointA: { geomId: lineIds[2], vertexIndex: 1 }, pointB: { geomId: lineIds[3], vertexIndex: 0 } },
    // left.end(1) ≡ top.start(0)
    { type: "coincident", id: cid(), pointA: { geomId: lineIds[3], vertexIndex: 1 }, pointB: { geomId: lineIds[0], vertexIndex: 0 } },
    // Horizontal: top, bottom
    { type: "horizontal", id: cid(), line: { geomId: lineIds[0] } },
    { type: "horizontal", id: cid(), line: { geomId: lineIds[2] } },
    // Vertical: right, left
    { type: "vertical", id: cid(), line: { geomId: lineIds[1] } },
    { type: "vertical", id: cid(), line: { geomId: lineIds[3] } },
  ];

  return { geometries, constraints };
}
