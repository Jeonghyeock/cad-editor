// 회전(Rotate) 도구: 선택된 기하를 복제 + 회전
// 상태: 중심점 클릭 → 시작각 클릭 → 끝각 클릭
// store.selectedIds에서 복제 대상 가져옴

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import { isReferenceId } from "../SketchGeometryStore";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";
import { cloneInternalConstraints } from "./editToolUtils";

type RotateState = "idle" | "start-angle" | "end-angle";

export class RotateDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "rotate";

  // 복제 인스턴스 수 (1 = 단일 복제, N = 누적 회전으로 N개 생성)
  instanceCount = 1;

  private _state: RotateState = "idle";
  private _center: { x: number; y: number } | null = null;
  private _startAngle = 0;
  private _targetIds: string[] = [];

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._targetIds.length === 0) {
      this._targetIds = this._getValidTargets(store);
      if (this._targetIds.length === 0) return;
    }

    if (this._state === "idle") {
      // 중심점 클릭
      this._center = { ...snappedPos };
      this._state = "start-angle";
      store.requestRender();
    } else if (this._state === "start-angle" && this._center) {
      // 시작각 클릭
      this._startAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      this._state = "end-angle";
      store.requestRender();
    } else if (this._state === "end-angle" && this._center) {
      // 끝각 클릭 → 회전 실행
      const endAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      const angle = endAngle - this._startAngle;
      if (Math.abs(angle) < 1e-6) return;

      this._executeRotateMulti(store, angle);
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._targetIds.length === 0) {
      this._targetIds = this._getValidTargets(store);
    }

    if (this._state === "end-angle" && this._center) {
      const endAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      const angle = endAngle - this._startAngle;

      // 회전 호 프리뷰 (중심에서 마우스까지의 선)
      this.preview = {
        type: "line",
        id: "__rotate_radius__",
        x1: this._center.x,
        y1: this._center.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };

      // 회전된 기하 프리뷰 (instanceCount만큼 누적)
      const count = Math.max(1, this.instanceCount);
      const allPreviews: SerializedGeometry[] = [];
      for (let i = 1; i <= count; i++) {
        allPreviews.push(...this._computeRotatedGeometries(store, angle * i, true, i));
      }
      this.previews = allPreviews;
      store.requestRender();
    } else if (this._state === "start-angle" && this._center) {
      // 시작 방향선 프리뷰
      this.preview = {
        type: "line",
        id: "__rotate_start__",
        x1: this._center.x,
        y1: this._center.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };
      store.requestRender();
    }
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "N", label: "N", value: this.instanceCount },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (values.N !== undefined) {
      this.instanceCount = Math.max(1, Math.round(values.N));
    }
    if (values.H !== undefined && values.V !== undefined) {
      this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  hasPendingWork(): boolean {
    return this._state !== "idle";
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._center = null;
    this._startAngle = 0;
    this._targetIds = [];
  }

  // --- 내부 ---

  private _getValidTargets(store: SketchGeometryStore): string[] {
    return store.selectedIds.filter((id) => {
      if (isReferenceId(id)) return false;
      const geom = store.geometries.get(id);
      if (!geom) return false;
      if (geom.type === "polygon") return false;
      if (geom.isReference) return false;
      return true;
    });
  }

  // 점 회전
  private _rotatePoint(
    px: number, py: number,
    cx: number, cy: number,
    angle: number,
  ): { x: number; y: number } {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = px - cx;
    const dy = py - cy;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    };
  }

  private _computeRotatedGeometries(
    store: SketchGeometryStore,
    angle: number,
    isPreview: boolean,
    instanceIdx = 1,
  ): SerializedGeometry[] {
    if (!this._center) return [];
    const cx = this._center.x;
    const cy = this._center.y;
    const result: SerializedGeometry[] = [];

    for (const id of this._targetIds) {
      const geom = store.geometries.get(id);
      if (!geom) continue;

      const newId = isPreview ? `__rotate_preview_${instanceIdx}_${id}__` : this._generateId();

      switch (geom.type) {
        case "point": {
          const p = this._rotatePoint(geom.x, geom.y, cx, cy, angle);
          result.push({ type: "point", id: newId, x: p.x, y: p.y, isConstruction: geom.isConstruction });
          break;
        }
        case "line": {
          const p1 = this._rotatePoint(geom.x1, geom.y1, cx, cy, angle);
          const p2 = this._rotatePoint(geom.x2, geom.y2, cx, cy, angle);
          result.push({ type: "line", id: newId, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, isConstruction: geom.isConstruction });
          break;
        }
        case "circle": {
          const c = this._rotatePoint(geom.cx, geom.cy, cx, cy, angle);
          result.push({ type: "circle", id: newId, cx: c.x, cy: c.y, r: geom.r, isConstruction: geom.isConstruction });
          break;
        }
        case "arc": {
          const c = this._rotatePoint(geom.cx, geom.cy, cx, cy, angle);
          result.push({
            type: "arc", id: newId,
            cx: c.x, cy: c.y, r: geom.r,
            startAngle: geom.startAngle + angle,
            endAngle: geom.endAngle + angle,
            isConstruction: geom.isConstruction,
          });
          break;
        }
        case "curve": {
          const rotatedPoints = geom.points.map((pt) =>
            this._rotatePoint(pt.x, pt.y, cx, cy, angle),
          );
          // 접선 벡터도 회전 (방향 벡터이므로 원점 기준 회전)
          const rotTanStart = geom.tangentStart
            ? this._rotatePoint(geom.tangentStart.x, geom.tangentStart.y, 0, 0, angle)
            : undefined;
          const rotTanEnd = geom.tangentEnd
            ? this._rotatePoint(geom.tangentEnd.x, geom.tangentEnd.y, 0, 0, angle)
            : undefined;
          result.push({
            type: "curve", id: newId,
            points: rotatedPoints,
            degree: geom.degree,
            knots: geom.knots ? [...geom.knots] : undefined,
            weights: geom.weights ? [...geom.weights] : undefined,
            tangentStart: rotTanStart,
            tangentEnd: rotTanEnd,
            isConstruction: geom.isConstruction,
          });
          break;
        }
        // polygon은 스킵
      }
    }

    return result;
  }

  // 다중 인스턴스 회전 실행
  private _executeRotateMulti(
    store: SketchGeometryStore,
    angle: number,
  ): void {
    const count = Math.max(1, this.instanceCount);
    const allGeoms: SerializedGeometry[] = [];
    const allConstraints: ReturnType<typeof cloneInternalConstraints> = [];

    for (let i = 1; i <= count; i++) {
      const rotated = this._computeRotatedGeometries(store, angle * i, false, i);
      if (rotated.length === 0) continue;

      const oldIds = this._targetIds;
      const newIds = rotated.map((g) => g.id);
      allGeoms.push(...rotated);
      allConstraints.push(...cloneInternalConstraints(store, oldIds, newIds));
    }

    if (allGeoms.length === 0) {
      this.cancel();
      return;
    }

    store.execute(new CompoundSketchCommand([], allGeoms, [], allConstraints));
    this.cancel();
    store.requestRender();
  }
}
