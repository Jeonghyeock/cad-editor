// Shape 삭제 커맨드 (글로벌 히스토리용)

import type { SketchShape } from "../../sketch/shapeDetector";
import type { SketchGeometryStore } from "../../sketch/SketchGeometryStore";

import type { GlobalCommand } from "../GlobalCommand";

/** Shape + 구성 geometry + 관련 constraint를 삭제하는 커맨드 (undo 지원) */
export class DeleteShapeCommand implements GlobalCommand {
  readonly label = "Delete Shape";
  private _removedShape: SketchShape | null = null;
  private _removedShapeIndex = -1;
  private _removedGeometries: { id: string; data: ReturnType<SketchGeometryStore["geometries"]["get"]> }[] = [];
  private _removedConstraints: { id: string; data: unknown }[] = [];

  constructor(
    private _shapeId: string,
    private _geoStore: SketchGeometryStore,
    private _requestFullRedraw?: () => void,
  ) {}

  execute(): void {
    const shapeIdx = this._geoStore.shapes.findIndex((s) => s.id === this._shapeId);
    if (shapeIdx === -1) return;
    const shape = this._geoStore.shapes[shapeIdx];
    this._removedShape = structuredClone(shape);
    this._removedShapeIndex = shapeIdx;
    this._removedGeometries = [];
    this._removedConstraints = [];

    const lineIdSet = new Set(shape.lineIds);

    // geometry 삭제 전 백업
    for (const lid of shape.lineIds) {
      const geo = this._geoStore.geometries.get(lid);
      if (geo) {
        this._removedGeometries.push({ id: lid, data: structuredClone(geo) });
        this._geoStore.geometries.delete(lid);
      }
    }

    // 관련 constraint 삭제 전 백업
    if (this._geoStore.constraintStore) {
      for (const [cId, c] of this._geoStore.constraintStore.constraints) {
        const refs: string[] = [];
        if ("pointA" in c && c.pointA) refs.push((c.pointA as { geomId: string }).geomId);
        if ("pointB" in c && c.pointB) refs.push((c.pointB as { geomId: string }).geomId);
        if ("line" in c && c.line) refs.push((c.line as { geomId: string }).geomId);
        if (refs.some((r) => lineIdSet.has(r))) {
          this._removedConstraints.push({ id: cId, data: structuredClone(c) });
          this._geoStore.constraintStore.constraints.delete(cId);
        }
      }
    }

    // shape 삭제
    this._geoStore.shapes = this._geoStore.shapes.filter((s) => s.id !== this._shapeId);

    this._geoStore.markGeometryChanged();
    this._geoStore.markShapesChanged();
    this._requestFullRedraw?.();
    this._geoStore.requestRender();
  }

  undo(): void {
    if (!this._removedShape) return;

    // geometry 복원
    for (const { id, data } of this._removedGeometries) {
      if (data) this._geoStore.geometries.set(id, data as NonNullable<typeof data>);
    }

    // constraint 복원
    if (this._geoStore.constraintStore) {
      for (const { id, data } of this._removedConstraints) {
        this._geoStore.constraintStore.constraints.set(id, data as Parameters<typeof this._geoStore.constraintStore.constraints.set>[1]);
      }
    }

    // shape 복원 (원래 인덱스 위치에 삽입)
    const idx = Math.min(this._removedShapeIndex, this._geoStore.shapes.length);
    this._geoStore.shapes.splice(idx, 0, this._removedShape as SketchShape);

    this._geoStore.markGeometryChanged();
    this._geoStore.markShapesChanged();
    this._requestFullRedraw?.();
    this._geoStore.requestRender();
  }
}
