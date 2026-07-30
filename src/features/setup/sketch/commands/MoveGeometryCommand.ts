// 기하 프리미티브 이동 커맨드 (드래그 이동용)

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

// 기하 요소의 좌표를 dx, dy만큼 이동
export const translateGeometry = (geom: SerializedGeometry, dx: number, dy: number): SerializedGeometry => {
  switch (geom.type) {
    case "point":
      return { ...geom, x: geom.x + dx, y: geom.y + dy };
    case "line":
      return { ...geom, x1: geom.x1 + dx, y1: geom.y1 + dy, x2: geom.x2 + dx, y2: geom.y2 + dy };
    case "circle":
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };
    case "arc":
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };
    case "curve":
      return { ...geom, points: geom.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "ellipse":
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };
  }
};

export class MoveGeometryCommand implements GeometryCommand {
  private _ids: string[];
  private _dx: number;
  private _dy: number;

  constructor(ids: string[], dx: number, dy: number) {
    this._ids = ids;
    this._dx = dx;
    this._dy = dy;
  }

  execute(store: SketchGeometryStore): void {
    for (const id of this._ids) {
      const geom = store.geometries.get(id);
      if (geom) {
        store.geometries.set(id, translateGeometry(geom, this._dx, this._dy));
      }
    }
  }

  undo(store: SketchGeometryStore): void {
    for (const id of this._ids) {
      const geom = store.geometries.get(id);
      if (geom) {
        store.geometries.set(id, translateGeometry(geom, -this._dx, -this._dy));
      }
    }
  }
}
