// Mirror 도구: 선택된 기하를 대칭축 기준으로 복제
// CATIA Mirror 스타일: 기하 선택 → 도구 활성화 → 축 정의 (두 점 클릭 또는 기존 line 클릭) → 대칭 복제
// 상태 머신: idle → axis-start → execute

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import { isReferenceId } from "../SketchGeometryStore";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";
import { cloneInternalConstraints } from "./editToolUtils";

type MirrorState = "idle" | "axis-start";

export class MirrorDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "mirror";

  private _state: MirrorState = "idle";
  private _axisStart: { x: number; y: number } | null = null;
  // 미러 대상 기하 ID (도구 활성화 시점의 선택 스냅샷)
  private _targetIds: string[] = [];

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 첫 진입 시 미러 대상 스냅샷
    if (this._targetIds.length === 0) {
      this._targetIds = this._getValidTargets(store);
      if (this._targetIds.length === 0) return;
    }

    const hitRadius = this.inferenceRadius || 5;

    if (this._state === "idle") {
      // 기존 line 클릭 시 해당 선을 축으로 즉시 미러 실행
      const hitId = store.hitTest(snappedPos, hitRadius);
      if (hitId && !this._targetIds.includes(hitId)) {
        const geom = store.geometries.get(hitId);
        if (geom && geom.type === "line") {
          this._executeMirror(store, { x: geom.x1, y: geom.y1 }, { x: geom.x2, y: geom.y2 });
          return;
        }
      }

      // 축 시작점 설정
      this._axisStart = { x: snappedPos.x, y: snappedPos.y };
      this._state = "axis-start";
      store.requestRender();
      return;
    }

    if (this._state === "axis-start" && this._axisStart) {
      // 축 끝점 → 미러 실행
      const dx = snappedPos.x - this._axisStart.x;
      const dy = snappedPos.y - this._axisStart.y;
      if (Math.hypot(dx, dy) < 1e-6) return; // 같은 점 클릭 무시

      this._executeMirror(store, this._axisStart, snappedPos);
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 대상이 없으면 첫 진입 시 스냅샷 시도
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

      // 축 프리뷰 (construction line)
      this.preview = {
        type: "line",
        id: "__mirror_axis__",
        x1: this._axisStart.x,
        y1: this._axisStart.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };

      // 미러된 기하 프리뷰
      this.previews = this._computeMirroredGeometries(
        store,
        this._axisStart,
        snappedPos,
        true,
      );
      store.requestRender();
      return;
    }

    // idle 상태: 기존 선 위 호버 시 해당 선을 축으로 미러 프리뷰
    if (this._state === "idle" && this._targetIds.length > 0) {
      const hitRadius = this.inferenceRadius || 5;
      const hitId = store.hitTest(snappedPos, hitRadius);
      if (hitId && !this._targetIds.includes(hitId)) {
        const geom = store.geometries.get(hitId);
        if (geom && geom.type === "line") {
          // 축 프리뷰
          this.preview = {
            type: "line",
            id: "__mirror_axis__",
            x1: geom.x1,
            y1: geom.y1,
            x2: geom.x2,
            y2: geom.y2,
            isConstruction: true,
          };
          this.previews = this._computeMirroredGeometries(
            store,
            { x: geom.x1, y: geom.y1 },
            { x: geom.x2, y: geom.y2 },
            true,
          );
          store.requestRender();
          return;
        }
      }
      // 선 위가 아니면 프리뷰 클리어 (불필요한 requestRender 방지)
      if (this.preview !== null || this.previews.length > 0) {
        this.preview = null;
        this.previews = [];
        store.requestRender();
      }
    }
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // mirror는 pointerDown에서 처리
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

  // 참조 기하와 polygon을 제외한 유효 미러 대상 ID 반환
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

  // 점 반사: P' = 2 * (A + dot(P-A, d) * d) - P
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

  // 미러된 기하 배열 생성
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

      const newId = isPreview ? `__mirror_preview_${id}__` : this._generateId();

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
          // 각도 반전: 반사 시 start↔end 교환 + 축 각도 기준 반전
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
          result.push({
            type: "curve", id: newId,
            points: mirroredPoints,
            degree: geom.degree,
            knots: geom.knots ? [...geom.knots] : undefined,
            weights: geom.weights ? [...geom.weights] : undefined,
            isConstruction: geom.isConstruction,
          });
          break;
        }
        // polygon은 자동 생성 기하이므로 스킵
      }
    }

    return result;
  }

  // 미러 실행
  private _executeMirror(
    store: SketchGeometryStore,
    axisA: { x: number; y: number },
    axisB: { x: number; y: number },
  ): void {
    const mirrored = this._computeMirroredGeometries(store, axisA, axisB, false);
    if (mirrored.length === 0) {
      this.cancel();
      return;
    }

    // 내부 구속 복제
    const oldIds = this._targetIds;
    const newIds = mirrored.map((g) => g.id);
    const clonedConstraints = cloneInternalConstraints(store, oldIds, newIds);

    // 추가만 수행 (제거 없음)
    store.execute(new CompoundSketchCommand([], mirrored, [], clonedConstraints));

    this.cancel();
    store.requestRender();
  }
}
