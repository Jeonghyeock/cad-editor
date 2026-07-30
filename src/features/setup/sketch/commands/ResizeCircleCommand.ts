// 원/타원 반지름 변경 커맨드 (body 드래그용)
// 원본 값을 저장하여 정확한 undo 보장

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class ResizeCircleCommand implements GeometryCommand {
  // 원본 값 저장 (undo용, 첫 execute 시에만 캡처)
  private _origR = 0;
  private _origRx = 0;
  private _origRy = 0;
  private _executed = false;

  constructor(
    private _geomId: string,
    private _scale: number, // 반지름 배율 (newDist / origDist)
  ) {}

  execute(store: SketchGeometryStore): void {
    const geom = store.geometries.get(this._geomId);
    if (!geom) return;
    if (geom.type === "circle") {
      if (!this._executed) this._origR = geom.r;
      store.geometries.set(this._geomId, { ...geom, r: Math.max(0.1, this._origR * this._scale) });
    } else if (geom.type === "ellipse") {
      if (!this._executed) { this._origRx = geom.rx; this._origRy = geom.ry; }
      store.geometries.set(this._geomId, {
        ...geom,
        rx: Math.max(0.1, this._origRx * this._scale),
        ry: Math.max(0.1, this._origRy * this._scale),
      });
    }
    this._executed = true;
  }

  undo(store: SketchGeometryStore): void {
    const geom = store.geometries.get(this._geomId);
    if (!geom) return;
    if (geom.type === "circle") {
      store.geometries.set(this._geomId, { ...geom, r: this._origR });
    } else if (geom.type === "ellipse") {
      store.geometries.set(this._geomId, { ...geom, rx: this._origRx, ry: this._origRy });
    }
  }
}
