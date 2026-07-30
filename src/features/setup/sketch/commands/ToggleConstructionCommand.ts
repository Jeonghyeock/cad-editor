// 선택된 기하의 isConstruction 플래그 토글 커맨드

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class ToggleConstructionCommand implements GeometryCommand {
  private _ids: string[];

  constructor(ids: string[]) {
    this._ids = [...ids];
  }

  execute(store: SketchGeometryStore): void {
    this._toggle(store);
  }

  undo(store: SketchGeometryStore): void {
    // 토글이므로 execute = undo
    this._toggle(store);
  }

  private _toggle(store: SketchGeometryStore): void {
    for (const id of this._ids) {
      const geom = store.geometries.get(id);
      if (!geom) continue;
      // axis 는 isConstruction 개념 없음 (reference geometry — 항상 visible / dash-dot).
      if (geom.type === "axis") continue;
      store.geometries.set(id, { ...geom, isConstruction: !geom.isConstruction });
    }
  }
}
