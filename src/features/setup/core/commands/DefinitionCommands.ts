// Shape 삭제 커맨드 (글로벌 히스토리용)

import type { SketchConstraint } from "../../sketch/constraints/SketchConstraint.type";
import type { ShapeSnapshot, SketchGeometryStore } from "../../sketch/SketchGeometryStore";

import type { GlobalCommand } from "../GlobalCommand";

/** Shape + 구성 geometry + 관련 constraint를 삭제하는 커맨드 (undo 지원) */
export class DeleteShapeCommand implements GlobalCommand {
  readonly label = "Delete Shape";
  // 지운 shape 와 지운 변을 같이 쓰던 이웃 shape (undo 때 이미지·설정째 복원)
  private _removedShapes: ShapeSnapshot[] = [];
  private _removedGeometries: { id: string; data: ReturnType<SketchGeometryStore["geometries"]["get"]> }[] = [];
  private _removedConstraints: SketchConstraint[] = [];

  constructor(
    private _shapeId: string,
    private _geoStore: SketchGeometryStore,
    private _requestFullRedraw?: () => void,
  ) {}

  execute(): void {
    const shape = this._geoStore.shapes.find((s) => s.id === this._shapeId);
    if (!shape) return;
    const lineIdSet = new Set(shape.lineIds);
    // 지울 shape 뿐 아니라 지울 변을 같이 쓰는 이웃 shape 도 보관한다 — 이웃은 다음 recomputeShapes 때
    // 변을 잃어 버려지므로, undo 에서 같이 되돌리지 않으면 이미지·설정이 사라진다
    this._removedShapes = this._geoStore.snapshotShapesUsing(lineIdSet);
    this._removedGeometries = [];
    this._removedConstraints = [];

    // geometry 삭제 전 백업
    for (const lid of shape.lineIds) {
      const geo = this._geoStore.geometries.get(lid);
      if (geo) {
        this._removedGeometries.push({ id: lid, data: structuredClone(geo) });
        this._geoStore.geometries.delete(lid);
      }
    }

    // 관련 constraint 삭제 전 백업 — 구속 종류마다 참조 필드가 달라(circle·lineA·entityA 등)
    // getConstraintGeomIds 기반의 cascade 삭제를 써야 치수·평행 같은 구속이 고아로 남지 않는다
    if (this._geoStore.constraintStore) {
      this._removedConstraints = this._geoStore.constraintStore.removeConstraintsForGeometry(lineIdSet);
    }

    // shape 삭제
    this._geoStore.shapes = this._geoStore.shapes.filter((s) => s.id !== this._shapeId);

    this._geoStore.markGeometryChanged();
    this._geoStore.markShapesChanged();
    this._requestFullRedraw?.();
    this._geoStore.requestRender();
  }

  undo(): void {
    if (this._removedShapes.length === 0) return;

    // geometry 복원
    for (const { id, data } of this._removedGeometries) {
      if (data) this._geoStore.geometries.set(id, data as NonNullable<typeof data>);
    }

    // constraint 복원
    if (this._geoStore.constraintStore) {
      this._geoStore.constraintStore.addConstraints(this._removedConstraints);
    }

    // shape 복원 (원래 인덱스 위치에 삽입)
    this._geoStore.restoreShapes(this._removedShapes);

    this._geoStore.markGeometryChanged();
    this._geoStore.markShapesChanged();
    this._requestFullRedraw?.();
    this._geoStore.requestRender();
  }
}
