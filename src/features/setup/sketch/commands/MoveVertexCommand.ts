// 기하 프리미티브의 개별 꼭짓점 이동 커맨드

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

// 기하 요소의 특정 꼭짓점을 dx, dy만큼 이동 (라이브 이동에도 재사용)
export const moveVertex = (
  geom: SerializedGeometry,
  vertexIndex: number,
  dx: number,
  dy: number,
): SerializedGeometry => {
  switch (geom.type) {
    case "point":
      return { ...geom, x: geom.x + dx, y: geom.y + dy };

    case "line":
      if (vertexIndex === 0) return { ...geom, x1: geom.x1 + dx, y1: geom.y1 + dy };
      return { ...geom, x2: geom.x2 + dx, y2: geom.y2 + dy };

    case "circle":
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };

    case "arc": {
      if (vertexIndex === 0) {
        // 중심 이동
        return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };
      }
      // 시작점(1) 또는 끝점(2) → 반지름 + 각도 재계산
      const angleKey = vertexIndex === 1 ? "startAngle" : "endAngle";
      const currentAngle = geom[angleKey];
      const px = geom.cx + geom.r * Math.cos(currentAngle) + dx;
      const py = geom.cy + geom.r * Math.sin(currentAngle) + dy;
      const newR = Math.hypot(px - geom.cx, py - geom.cy);
      const newAngle = Math.atan2(py - geom.cy, px - geom.cx);
      return { ...geom, r: newR, [angleKey]: newAngle };
    }

    case "curve": {
      const points = geom.points.map((p, i) =>
        i === vertexIndex ? { x: p.x + dx, y: p.y + dy } : p,
      );
      return { ...geom, points };
    }

    case "ellipse":
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy };
  }
};

export class MoveVertexCommand implements GeometryCommand {
  private _geomId: string;
  private _vertexIndex: number;
  private _dx: number;
  private _dy: number;

  constructor(geomId: string, vertexIndex: number, dx: number, dy: number) {
    this._geomId = geomId;
    this._vertexIndex = vertexIndex;
    this._dx = dx;
    this._dy = dy;
  }

  execute(store: SketchGeometryStore): void {
    const geom = store.geometries.get(this._geomId);
    if (geom) {
      store.geometries.set(this._geomId, moveVertex(geom, this._vertexIndex, this._dx, this._dy));
    }
  }

  undo(store: SketchGeometryStore): void {
    const geom = store.geometries.get(this._geomId);
    if (geom) {
      store.geometries.set(this._geomId, moveVertex(geom, this._vertexIndex, -this._dx, -this._dy));
    }
  }
}
