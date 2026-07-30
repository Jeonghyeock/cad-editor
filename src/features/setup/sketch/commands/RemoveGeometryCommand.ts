// 기하 프리미티브 삭제 커맨드 (연관 구속조건 cascade 삭제 포함)

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class RemoveGeometryCommand implements GeometryCommand {
  private _geometries: SerializedGeometry[];
  // cascade 삭제된 구속조건 (undo 복원용)
  private _removedConstraints: SketchConstraint[] = [];

  constructor(geometries: SerializedGeometry[]) {
    this._geometries = geometries;
  }

  execute(store: SketchGeometryStore): void {
    const ids = new Set(this._geometries.map((g) => g.id));

    // 연관 구속조건 cascade 삭제 (백업)
    if (store.constraintStore) {
      this._removedConstraints = store.constraintStore.removeConstraintsForGeometry(ids);
    }

    for (const id of ids) {
      store.geometries.delete(id);
    }
    store.selectedIds = store.selectedIds.filter((id) => !ids.has(id));
    const h = store.hoveredItem;
    if (h && (h.kind === "geometry" || h.kind === "vertex") && ids.has(h.geomId)) store.hoveredItem = null;
  }

  undo(store: SketchGeometryStore): void {
    // 기하 복원
    for (const geom of this._geometries) {
      store.geometries.set(geom.id, geom);
    }
    // cascade 삭제된 구속조건 복원
    if (store.constraintStore && this._removedConstraints.length > 0) {
      store.constraintStore.addConstraints(this._removedConstraints);
    }
  }
}
