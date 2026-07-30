// 원 그리기 도구: 클릭(중심) → 이동(프리뷰) → 클릭(반지름 확정)
// 중심 스냅 시 auto-coincident 구속을 BatchCommand로 원자적 undo

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class CircleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "circle";

  private _center: { x: number; y: number } | null = null;
  private _centerSnap: SnapResult = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._center) {
      // 첫 클릭: 중심 설정 + 스냅 정보 캡처
      this._center = { ...snappedPos };
      this._centerSnap = store.snapResult;
    } else {
      // 두 번째 클릭: 원 확정
      const r = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);

      if (r > 0.1) {
        const circleId = this._generateId();
        const addCmd = this._addGeometry({
          type: "circle",
          id: circleId,
          cx: this._center.x,
          cy: this._center.y,
          r,
        });

        // center auto-coincident 구속 생성
        const autoConstraintCmds: GeometryCommand[] = [];
        const cst = this._buildAutoConstraint(store, circleId, 0, this._centerSnap);
        if (cst) autoConstraintCmds.push(cst);

        if (autoConstraintCmds.length > 0) {
          store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
        } else {
          store.execute(addCmd);
        }
      }

      this._center = null;
      this._centerSnap = null;
      this.preview = null;
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 기하 기반 추론선 (첫 클릭 전에도 작동)
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (!this._center) {
      store.requestRender();
      return;
    }

    const r = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
    this.preview = {
      type: "circle",
      id: "__preview__",
      cx: this._center.x,
      cy: this._center.y,
      r,
    };
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭-클릭 방식이므로 pointerUp에서는 처리 없음
  }

  hasPendingWork(): boolean {
    return this._center !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    const r = this._center && mousePos
      ? Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y) : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "R", label: "R", value: r },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (!this._center) {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    // R 입력 → 중심에서 R 거리의 점으로 클릭 (오른쪽 방향)
    if (values.R !== undefined) {
      this.onPointerDown(store, { x: this._center.x + values.R, y: this._center.y }, { x: this._center.x + values.R, y: this._center.y });
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._center = null;
    this._centerSnap = null;
  }
}
