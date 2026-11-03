// 스케일(Scale) 도구: 선택된 기하를 복제 + 스케일
// 상태: 중심점 클릭 → 시작점(원본 크기 기준) → 끝점(스케일 크기)
// 스케일 비율 = |끝점-중심| / |시작점-중심|

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import { isReferenceId } from "../SketchGeometryStore";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";
import { cloneInternalConstraints } from "./editToolUtils";

type ScaleState = "idle" | "ref-point" | "scale-point";

export class ScaleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "scale";

  // 복제 인스턴스 수 (1 = 단일 복제, N = 기하급수적으로 N개 생성)
  instanceCount = 1;

  private _state: ScaleState = "idle";
  private _center: { x: number; y: number } | null = null;
  private _refDist = 0; // |시작점 - 중심|
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
      this._state = "ref-point";
      store.requestRender();
    } else if (this._state === "ref-point" && this._center) {
      // 기준점 클릭
      const dist = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (dist < 1e-6) return;
      this._refDist = dist;
      this._state = "scale-point";
      store.requestRender();
    } else if (this._state === "scale-point" && this._center) {
      // 스케일 확정
      const dist = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      const scale = dist / this._refDist;
      if (Math.abs(scale - 1) < 1e-6 || scale < 1e-6) return;

      this._executeScaleMulti(store, scale);
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

    if (this._state === "scale-point" && this._center) {
      const dist = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      const scale = this._refDist > 1e-9 ? dist / this._refDist : 1;

      // 중심 → 마우스 방향선 프리뷰
      this.preview = {
        type: "line",
        id: "__scale_radius__",
        x1: this._center.x,
        y1: this._center.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };

      // 스케일된 기하 프리뷰 (instanceCount만큼 기하급수적)
      const count = Math.max(1, this.instanceCount);
      const allPreviews: SerializedGeometry[] = [];
      for (let i = 1; i <= count; i++) {
        allPreviews.push(...this._computeScaledGeometries(store, Math.pow(scale, i), true, i));
      }
      this.previews = allPreviews;
      store.requestRender();
    } else if (this._state === "ref-point" && this._center) {
      // 기준 방향선 프리뷰
      this.preview = {
        type: "line",
        id: "__scale_ref__",
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
    this._refDist = 0;
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

  // 점 스케일: 중심 기준 (p - center) * scale + center
  private _scalePoint(
    px: number, py: number,
    cx: number, cy: number,
    s: number,
  ): { x: number; y: number } {
    return {
      x: cx + (px - cx) * s,
      y: cy + (py - cy) * s,
    };
  }

  private _computeScaledGeometries(
    store: SketchGeometryStore,
    scale: number,
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

      const newId = isPreview ? `__scale_preview_${instanceIdx}_${id}__` : this._generateId();

      switch (geom.type) {
        case "point": {
          const p = this._scalePoint(geom.x, geom.y, cx, cy, scale);
          result.push({ type: "point", id: newId, x: p.x, y: p.y, isConstruction: geom.isConstruction });
          break;
        }
        case "line": {
          const p1 = this._scalePoint(geom.x1, geom.y1, cx, cy, scale);
          const p2 = this._scalePoint(geom.x2, geom.y2, cx, cy, scale);
          result.push({ type: "line", id: newId, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, isConstruction: geom.isConstruction });
          break;
        }
        case "circle": {
          const c = this._scalePoint(geom.cx, geom.cy, cx, cy, scale);
          result.push({ type: "circle", id: newId, cx: c.x, cy: c.y, r: geom.r * scale, isConstruction: geom.isConstruction });
          break;
        }
        case "arc": {
          const c = this._scalePoint(geom.cx, geom.cy, cx, cy, scale);
          result.push({
            type: "arc", id: newId,
            cx: c.x, cy: c.y, r: geom.r * scale,
            startAngle: geom.startAngle, endAngle: geom.endAngle,
            isConstruction: geom.isConstruction,
          });
          break;
        }
        case "curve": {
          const scaledPoints = geom.points.map((pt) =>
            this._scalePoint(pt.x, pt.y, cx, cy, scale),
          );
          result.push({
            type: "curve", id: newId,
            points: scaledPoints,
            degree: geom.degree,
            knots: geom.knots ? [...geom.knots] : undefined,
            weights: geom.weights ? [...geom.weights] : undefined,
            tangentStart: geom.tangentStart ? { ...geom.tangentStart } : undefined,
            tangentEnd: geom.tangentEnd ? { ...geom.tangentEnd } : undefined,
            isConstruction: geom.isConstruction,
          });
          break;
        }
        // polygon은 스킵
      }
    }

    return result;
  }

  // 다중 인스턴스 스케일 실행 (기하급수적: scale^1, scale^2, ..., scale^N)
  private _executeScaleMulti(
    store: SketchGeometryStore,
    scale: number,
  ): void {
    const count = Math.max(1, this.instanceCount);
    const allGeoms: SerializedGeometry[] = [];
    const allConstraints: ReturnType<typeof cloneInternalConstraints> = [];

    for (let i = 1; i <= count; i++) {
      const factor = Math.pow(scale, i);
      const scaled = this._computeScaledGeometries(store, factor, false, i);
      if (scaled.length === 0) continue;

      const oldIds = this._targetIds;
      const newIds = scaled.map((g) => g.id);
      allGeoms.push(...scaled);
      allConstraints.push(...cloneInternalConstraints(store, oldIds, newIds, { kind: "scale", factor }));
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
