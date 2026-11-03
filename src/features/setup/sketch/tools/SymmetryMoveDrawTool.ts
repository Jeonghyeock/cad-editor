// Symmetry Move 도구: Mirror와 동일하지만 원본 삭제
// 선택 기하 + 축선 → 대칭 복사 후 원본 제거
// MirrorDrawTool 기반으로 CompoundSketchCommand 사용

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import { isReferenceId } from "../SketchGeometryStore";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";
import { cloneInternalConstraints } from "./editToolUtils";

type SymmetryState = "idle" | "axis-start";

export class SymmetryMoveDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "symmetry-move";

  private _state: SymmetryState = "idle";
  private _axisStart: { x: number; y: number } | null = null;
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

    const hitRadius = this.inferenceRadius || 5;

    if (this._state === "idle") {
      // 기존 line 클릭 시 해당 선을 축으로 즉시 실행
      const hitId = store.hitTest(snappedPos, hitRadius);
      if (hitId && !this._targetIds.includes(hitId)) {
        const geom = store.geometries.get(hitId);
        if (geom && geom.type === "line") {
          this._executeSymmetryMove(store, { x: geom.x1, y: geom.y1 }, { x: geom.x2, y: geom.y2 });
          return;
        }
      }

      this._axisStart = { x: snappedPos.x, y: snappedPos.y };
      this._state = "axis-start";
      store.requestRender();
      return;
    }

    if (this._state === "axis-start" && this._axisStart) {
      const dx = snappedPos.x - this._axisStart.x;
      const dy = snappedPos.y - this._axisStart.y;
      if (Math.hypot(dx, dy) < 1e-6) return;

      this._executeSymmetryMove(store, this._axisStart, snappedPos);
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

    if (this._state === "axis-start" && this._axisStart) {
      const dx = snappedPos.x - this._axisStart.x;
      const dy = snappedPos.y - this._axisStart.y;
      if (Math.hypot(dx, dy) < 1e-6) {
        this.previews = [];
        this.inferenceLines = [];
        store.requestRender();
        return;
      }

      // 축 프리뷰
      this.preview = {
        type: "line",
        id: "__symmetry_axis__",
        x1: this._axisStart.x,
        y1: this._axisStart.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };

      this.previews = this._computeMirroredGeometries(
        store, this._axisStart, snappedPos, true,
      );
      store.requestRender();
      return;
    }

    // idle: 기존 선 위 호버 시 프리뷰
    if (this._state === "idle" && this._targetIds.length > 0) {
      const hitRadius = this.inferenceRadius || 5;
      const hitId = store.hitTest(snappedPos, hitRadius);
      if (hitId && !this._targetIds.includes(hitId)) {
        const geom = store.geometries.get(hitId);
        if (geom && geom.type === "line") {
          this.preview = {
            type: "line", id: "__symmetry_axis__",
            x1: geom.x1, y1: geom.y1, x2: geom.x2, y2: geom.y2,
            isConstruction: true,
          };
          this.previews = this._computeMirroredGeometries(
            store, { x: geom.x1, y: geom.y1 }, { x: geom.x2, y: geom.y2 }, true,
          );
          store.requestRender();
          return;
        }
      }
      if (this.preview !== null || this.previews.length > 0) {
        this.preview = null;
        this.previews = [];
        store.requestRender();
      }
    }
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // pointerDown에서 처리
  }

  hasPendingWork(): boolean {
    return this._state === "axis-start";
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._axisStart = null;
    this._targetIds = [];
  }

  // --- 내부 유틸리티 ---

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

  private _reflectPoint(
    px: number, py: number,
    ax: number, ay: number,
    dx: number, dy: number,
  ): { x: number; y: number } {
    const apx = px - ax, apy = py - ay;
    const dot = apx * dx + apy * dy;
    return {
      x: 2 * (ax + dot * dx) - px,
      y: 2 * (ay + dot * dy) - py,
    };
  }

  private _computeMirroredGeometries(
    store: SketchGeometryStore,
    axisA: { x: number; y: number },
    axisB: { x: number; y: number },
    isPreview: boolean,
  ): SerializedGeometry[] {
    const dx = axisB.x - axisA.x;
    const dy = axisB.y - axisA.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return [];
    const ux = dx / len, uy = dy / len;

    const result: SerializedGeometry[] = [];

    for (const id of this._targetIds) {
      const geom = store.geometries.get(id);
      if (!geom) continue;

      const newId = isPreview ? `__sym_preview_${id}__` : this._generateId();

      switch (geom.type) {
        case "point": {
          const p = this._reflectPoint(geom.x, geom.y, axisA.x, axisA.y, ux, uy);
          result.push({ type: "point", id: newId, x: p.x, y: p.y, isConstruction: geom.isConstruction });
          break;
        }
        case "line": {
          const p1 = this._reflectPoint(geom.x1, geom.y1, axisA.x, axisA.y, ux, uy);
          const p2 = this._reflectPoint(geom.x2, geom.y2, axisA.x, axisA.y, ux, uy);
          result.push({ type: "line", id: newId, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, isConstruction: geom.isConstruction });
          break;
        }
        case "circle": {
          const c = this._reflectPoint(geom.cx, geom.cy, axisA.x, axisA.y, ux, uy);
          result.push({ type: "circle", id: newId, cx: c.x, cy: c.y, r: geom.r, isConstruction: geom.isConstruction });
          break;
        }
        case "arc": {
          const c = this._reflectPoint(geom.cx, geom.cy, axisA.x, axisA.y, ux, uy);
          const axisAngle = Math.atan2(uy, ux);
          const newStart = 2 * axisAngle - geom.endAngle;
          const newEnd = 2 * axisAngle - geom.startAngle;
          result.push({
            type: "arc", id: newId,
            cx: c.x, cy: c.y, r: geom.r,
            startAngle: newStart, endAngle: newEnd,
            isConstruction: geom.isConstruction,
          });
          break;
        }
        case "curve": {
          const mirroredPoints = geom.points.map((pt) =>
            this._reflectPoint(pt.x, pt.y, axisA.x, axisA.y, ux, uy),
          );
          // 접선 벡터도 반사 (방향 벡터이므로 원점 기준 반사)
          const mirTanStart = geom.tangentStart
            ? this._reflectPoint(geom.tangentStart.x, geom.tangentStart.y, 0, 0, ux, uy)
            : undefined;
          const mirTanEnd = geom.tangentEnd
            ? this._reflectPoint(geom.tangentEnd.x, geom.tangentEnd.y, 0, 0, ux, uy)
            : undefined;
          result.push({
            type: "curve", id: newId,
            points: mirroredPoints,
            degree: geom.degree,
            knots: geom.knots ? [...geom.knots] : undefined,
            weights: geom.weights ? [...geom.weights] : undefined,
            tangentStart: mirTanStart,
            tangentEnd: mirTanEnd,
            isConstruction: geom.isConstruction,
          });
          break;
        }
      }
    }

    return result;
  }

  private _executeSymmetryMove(
    store: SketchGeometryStore,
    axisA: { x: number; y: number },
    axisB: { x: number; y: number },
  ): void {
    const mirrored = this._computeMirroredGeometries(store, axisA, axisB, false);
    if (mirrored.length === 0) {
      this.cancel();
      return;
    }

    // 내부 구속 복제 (원본 제거 전에 수행)
    const oldIds = this._targetIds;
    const newIds = mirrored.map((g) => g.id);
    const axisAngle = Math.atan2(axisB.y - axisA.y, axisB.x - axisA.x);
    const clonedConstraints = cloneInternalConstraints(store, oldIds, newIds, { kind: "mirror", axisAngle });

    // 원본 기하 수집
    const removedGeoms = this._targetIds
      .map((id) => store.geometries.get(id))
      .filter((g): g is SerializedGeometry => g !== undefined);

    // 원본 제거 + 대칭 복사본 추가 + 복제된 구속 추가
    store.execute(new CompoundSketchCommand(removedGeoms, mirrored, [], clonedConstraints));

    this.cancel();
    store.requestRender();
  }
}
