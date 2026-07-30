// 기하 프리미티브 추가 커맨드

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class AddGeometryCommand implements GeometryCommand {
  private _geometry: SerializedGeometry;

  constructor(geometry: SerializedGeometry) {
    this._geometry = geometry;
  }

  execute(store: SketchGeometryStore): void {
    store.geometries.set(this._geometry.id, this._geometry);
    // circle/ellipse는 자체 closed loop → shape 직접 등록
    if (this._geometry.type === "circle" || this._geometry.type === "ellipse") {
      store.registerShape([this._geometry.id]);
    }
  }

  undo(store: SketchGeometryStore): void {
    if (this._geometry.type === "circle" || this._geometry.type === "ellipse") {
      store.unregisterShape([this._geometry.id]);
    }
    store.geometries.delete(this._geometry.id);
    store.selectedIds = store.selectedIds.filter((id) => id !== this._geometry.id);
    const h = store.hoveredItem;
    if (h && (h.kind === "geometry" || h.kind === "vertex") && h.geomId === this._geometry.id) store.hoveredItem = null;
  }
}
