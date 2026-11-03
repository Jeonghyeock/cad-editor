// 평행이동(Translate) 도구: 선택된 기하를 복제 + 벡터만큼 이동
// 상태: 시작점 클릭 → 끝점 클릭 → 벡터만큼 복제
// store.selectedIds에서 복제 대상 가져옴

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import { isReferenceId } from "../SketchGeometryStore";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";
import { cloneInternalConstraints } from "./editToolUtils";

type TranslateState = "idle" | "end-point";

export class TranslateDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "translate";

  // 복제 인스턴스 수 (1 = 단일 복제, N = 누적 변환으로 N개 생성)
  instanceCount = 1;

  private _state: TranslateState = "idle";
  private _startPoint: { x: number; y: number } | null = null;
  private _targetIds: string[] = [];

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 첫 진입 시 대상 스냅샷
    if (this._targetIds.length === 0) {
      this._targetIds = this._getValidTargets(store);
      if (this._targetIds.length === 0) return;
    }

    if (this._state === "idle") {
      // 시작점 클릭
      this._startPoint = { ...snappedPos };
      this._state = "end-point";
      store.requestRender();
    } else if (this._state === "end-point" && this._startPoint) {
      // 끝점 클릭 → 복제 실행 (instanceCount만큼 누적 이동)
      const dx = snappedPos.x - this._startPoint.x;
      const dy = snappedPos.y - this._startPoint.y;
      if (Math.hypot(dx, dy) < 1e-6) return;

      this._executeTranslateMulti(store, dx, dy);
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

    if (this._state === "end-point" && this._startPoint) {
      const dx = snappedPos.x - this._startPoint.x;
      const dy = snappedPos.y - this._startPoint.y;

      // 이동 벡터 프리뷰 (construction line)
      this.preview = {
        type: "line",
        id: "__translate_vector__",
        x1: this._startPoint.x,
        y1: this._startPoint.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };

      // 복제된 기하 프리뷰 (instanceCount만큼 누적)
      const allPreviews: SerializedGeometry[] = [];
      const count = Math.max(1, this.instanceCount);
      for (let i = 1; i <= count; i++) {
        allPreviews.push(...this._computeTranslatedGeometries(store, dx * i, dy * i, true, i));
      }
      this.previews = allPreviews;
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
    // N 값 적용
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
    return this._state === "end-point";
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._startPoint = null;
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

  private _computeTranslatedGeometries(
    store: SketchGeometryStore,
    dx: number,
    dy: number,
    isPreview: boolean,
    instanceIdx = 1,
  ): SerializedGeometry[] {
    const result: SerializedGeometry[] = [];

    for (const id of this._targetIds) {
      const geom = store.geometries.get(id);
      if (!geom) continue;

      const newId = isPreview ? `__translate_preview_${instanceIdx}_${id}__` : this._generateId();

      switch (geom.type) {
        case "point":
          result.push({ type: "point", id: newId, x: geom.x + dx, y: geom.y + dy, isConstruction: geom.isConstruction });
          break;
        case "line":
          result.push({ type: "line", id: newId, x1: geom.x1 + dx, y1: geom.y1 + dy, x2: geom.x2 + dx, y2: geom.y2 + dy, isConstruction: geom.isConstruction });
          break;
        case "circle":
          result.push({ type: "circle", id: newId, cx: geom.cx + dx, cy: geom.cy + dy, r: geom.r, isConstruction: geom.isConstruction });
          break;
        case "arc":
          result.push({ type: "arc", id: newId, cx: geom.cx + dx, cy: geom.cy + dy, r: geom.r, startAngle: geom.startAngle, endAngle: geom.endAngle, isConstruction: geom.isConstruction });
          break;
        case "curve":
          result.push({
            type: "curve", id: newId,
            points: geom.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
            degree: geom.degree,
            knots: geom.knots ? [...geom.knots] : undefined,
            weights: geom.weights ? [...geom.weights] : undefined,
            tangentStart: geom.tangentStart ? { ...geom.tangentStart } : undefined,
            tangentEnd: geom.tangentEnd ? { ...geom.tangentEnd } : undefined,
            isConstruction: geom.isConstruction,
          });
          break;
        // polygon은 스킵
      }
    }

    return result;
  }

  // 다중 인스턴스 평행이동 실행
  private _executeTranslateMulti(
    store: SketchGeometryStore,
    dx: number,
    dy: number,
  ): void {
    const count = Math.max(1, this.instanceCount);
    const allGeoms: SerializedGeometry[] = [];
    const allConstraints: ReturnType<typeof cloneInternalConstraints> = [];

    for (let i = 1; i <= count; i++) {
      const translated = this._computeTranslatedGeometries(store, dx * i, dy * i, false, i);
      if (translated.length === 0) continue;

      const oldIds = this._targetIds;
      const newIds = translated.map((g) => g.id);
      allGeoms.push(...translated);
      allConstraints.push(...cloneInternalConstraints(store, oldIds, newIds, { kind: "translate" }));
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
