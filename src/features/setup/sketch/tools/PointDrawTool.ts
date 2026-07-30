// 점 그리기 도구: 클릭 → 점 배치
// 스냅 시 auto-coincident 구속을 BatchCommand로 원자적 undo

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class PointDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "point";

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const pointId = this._generateId();
    const addCmd = this._addGeometry({
      type: "point",
      id: pointId,
      x: snappedPos.x,
      y: snappedPos.y,
    });

    // 스냅 위치에 auto-coincident 구속 생성
    const autoConstraintCmds: GeometryCommand[] = [];
    const cst = this._buildAutoConstraint(store, pointId, 0, store.snapResult);
    if (cst) autoConstraintCmds.push(cst);

    if (autoConstraintCmds.length > 0) {
      store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
    } else {
      store.execute(addCmd);
    }
  }

  onPointerMove(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 점은 프리뷰 없음
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 점은 pointerDown에서 즉시 확정
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
}
