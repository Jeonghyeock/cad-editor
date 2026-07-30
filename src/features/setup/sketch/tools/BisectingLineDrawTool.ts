// 이등분선 생성 도구: 선택된 2개 line의 교차점에서 각도 이등분선을 construction line으로 생성
// 선택 모드: 2개 line을 순차 클릭 → 교차점에서 이등분선 자동 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddGeometryCommand } from "../commands/AddGeometryCommand";
import { lineLineIntersectionUnbounded } from "../GeometryIntersection";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class BisectingLineDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "bisecting-line";

  private _firstLineId: string | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(snappedPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom || geom.type !== "line") return;
    if (geom.isReference || geom.isConstruction) return;

    if (!this._firstLineId) {
      // 첫 번째 선 선택
      this._firstLineId = hitId;
      store.selectedIds = [hitId];
      store.requestRender();
      return;
    }

    if (hitId === this._firstLineId) return; // 같은 선 클릭 무시

    // 두 번째 선 선택 → 이등분선 생성
    const line1 = store.geometries.get(this._firstLineId);
    if (!line1 || line1.type !== "line") {
      this._reset();
      return;
    }

    const line2 = geom;
    this._createBisectingLine(store, line1, line2);
    this._reset();
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 호버 시 이등분선 프리뷰
    if (!this._firstLineId) {
      this.preview = null;
      this.previews = [];
      store.requestRender();
      return;
    }

    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(snappedPos, hitRadius);
    if (!hitId || hitId === this._firstLineId) {
      this.preview = null;
      this.previews = [];
      store.requestRender();
      return;
    }

    const line1 = store.geometries.get(this._firstLineId);
    const line2 = store.geometries.get(hitId);
    if (!line1 || line1.type !== "line" || !line2 || line2.type !== "line") {
      this.preview = null;
      this.previews = [];
      store.requestRender();
      return;
    }

    // 이등분선 프리뷰 계산
    const bisector = this._computeBisector(line1, line2);
    if (bisector) {
      this.preview = {
        type: "line", id: "__bisect_preview__",
        x1: bisector.x1, y1: bisector.y1,
        x2: bisector.x2, y2: bisector.y2,
        isConstruction: true,
      };
    } else {
      this.preview = null;
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // pointerDown에서 처리
  }

  hasPendingWork(): boolean {
    return this._firstLineId !== null;
  }

  cancel(): void {
    super.cancel();
    this._reset();
  }

  // --- 내부 ---

  // 두 선의 교차점 + 이등분 방향 계산
  private _computeBisector(
    line1: SerializedGeometry & { type: "line" },
    line2: SerializedGeometry & { type: "line" },
  ): { x1: number; y1: number; x2: number; y2: number } | null {
    const hit = lineLineIntersectionUnbounded(
      line1.x1, line1.y1, line1.x2, line1.y2,
      line2.x1, line2.y1, line2.x2, line2.y2,
    );
    if (!hit) return null; // 평행선

    // 두 선의 방향 벡터 (단위 벡터)
    const d1x = line1.x2 - line1.x1, d1y = line1.y2 - line1.y1;
    const len1 = Math.hypot(d1x, d1y);
    if (len1 < 1e-9) return null;
    const u1x = d1x / len1, u1y = d1y / len1;

    const d2x = line2.x2 - line2.x1, d2y = line2.y2 - line2.y1;
    const len2 = Math.hypot(d2x, d2y);
    if (len2 < 1e-9) return null;
    const u2x = d2x / len2, u2y = d2y / len2;

    // 이등분 방향: 두 단위 벡터의 합
    let bx = u1x + u2x;
    let by = u1y + u2y;
    const bLen = Math.hypot(bx, by);
    if (bLen < 1e-9) {
      // 두 벡터가 정반대 → 수직 이등분선 사용
      bx = -u1y;
      by = u1x;
    } else {
      bx /= bLen;
      by /= bLen;
    }

    // 교차점에서 양방향으로 적절한 길이의 이등분선
    const bisectLen = Math.max(len1, len2) * 0.5;
    return {
      x1: hit.x - bx * bisectLen,
      y1: hit.y - by * bisectLen,
      x2: hit.x + bx * bisectLen,
      y2: hit.y + by * bisectLen,
    };
  }

  private _createBisectingLine(
    store: SketchGeometryStore,
    line1: SerializedGeometry & { type: "line" },
    line2: SerializedGeometry & { type: "line" },
  ): void {
    const bisector = this._computeBisector(line1, line2);
    if (!bisector) return;

    const id = this._generateId();
    store.execute(new AddGeometryCommand({
      type: "line",
      id,
      x1: bisector.x1,
      y1: bisector.y1,
      x2: bisector.x2,
      y2: bisector.y2,
      isConstruction: true,
    }));
  }

  private _reset(): void {
    this._firstLineId = null;
    this.preview = null;
    this.previews = [];
  }
}
