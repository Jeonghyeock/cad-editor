// 이미지 삽입 커맨드 — 4 line + 8 constraint (rectangle) + shape (image 속성)
// 한 번에 atomic 추가/제거하여 ctrl+z 일관성 보장.

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class InsertImageCommand implements GeometryCommand {
  constructor(
    private _lineIds: string[],
    private _geometries: SerializedGeometry[],
    private _constraints: SketchConstraint[],
    private _imageDataUrl: string,
  ) {}

  execute(store: SketchGeometryStore): void {
    for (const g of this._geometries) {
      store.geometries.set(g.id, g);
    }
    if (store.constraintStore) {
      store.constraintStore.addConstraints(this._constraints);
    }
    store.registerShape(this._lineIds);
    const shape = store.shapes.find(
      (s) =>
        s.lineIds.length === this._lineIds.length &&
        s.lineIds.every((id, i) => id === this._lineIds[i]),
    );
    if (shape) {
      shape.image = this._imageDataUrl;
      shape.imageVisibility = true;
    }
  }

  undo(store: SketchGeometryStore): void {
    if (store.constraintStore) {
      for (const c of this._constraints) {
        store.constraintStore.constraints.delete(c.id);
      }
    }
    for (const g of this._geometries) {
      store.geometries.delete(g.id);
      store.selectedIds = store.selectedIds.filter((id) => id !== g.id);
    }
    store.unregisterShape(this._lineIds);
  }
}
