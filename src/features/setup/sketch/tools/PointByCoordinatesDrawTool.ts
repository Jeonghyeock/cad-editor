// 좌표 입력으로 점 생성 도구
// 클릭 시 현재 마우스 위치를 초기값으로 점을 바로 생성
// 별도 좌표 패널에서 x, y 값을 직접 입력할 수도 있도록 setCoordinate 메서드 제공

import type { SketchDrawToolType } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class PointByCoordinatesDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "point-coordinates";

  // 외부에서 좌표를 직접 설정하여 점 생성 시 사용
  private _pendingStore: SketchGeometryStore | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 클릭 위치에 점 즉시 생성
    this._createPoint(store, snappedPos.x, snappedPos.y);
  }

  onPointerMove(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 프리뷰 없음 (좌표 입력 도구이므로)
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // pointerDown에서 즉시 확정
  }

  hasPendingWork(): boolean {
    return false;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (values.H !== undefined && values.V !== undefined) {
      this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._pendingStore = null;
  }

  // 외부 패널에서 좌표를 지정하여 점 생성 (SnapInfoPanel 등에서 호출)
  setStore(store: SketchGeometryStore): void {
    this._pendingStore = store;
  }

  createAtCoordinate(x: number, y: number): void {
    if (!this._pendingStore) return;
    this._createPoint(this._pendingStore, x, y);
  }

  private _createPoint(store: SketchGeometryStore, x: number, y: number): void {
    const pointId = this._generateId();
    store.execute(this._addGeometry({
      type: "point",
      id: pointId,
      x,
      y,
    }));
  }
}
