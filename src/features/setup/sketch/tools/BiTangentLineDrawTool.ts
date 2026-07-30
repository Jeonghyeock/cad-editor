// 2개 곡선에 접하는 직선 도구 (Bi-Tangent Line)
// 2클릭: circle/arc 2개를 선택하여 양쪽 모두에 접하는 직선 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type CircleInfo = {
  cx: number;
  cy: number;
  r: number;
  geomId: string;
};

export class BiTangentLineDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "bi-tangent-line";


  selectionOnly = true;
  private _firstElement: CircleInfo | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.hitRadius;
    const hitId = store.hitTest(rawPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom) return;

    const circleInfo = this._extractCircleInfo(geom);
    if (!circleInfo) return;

    if (!this._firstElement) {
      this._firstElement = circleInfo;
      store.requestRender();
      return;
    }

    // 동일 요소 선택 방지
    if (this._firstElement.geomId === circleInfo.geomId) return;

    // 외접선 계산 (커서 위치에 가장 가까운 접선 선택)
    const tangentLines = this._computeExternalTangentLines(this._firstElement, circleInfo);
    if (tangentLines.length === 0) {
      this._reset();
      return;
    }

    // 커서에 가장 가까운 접선 선택
    let bestLine = tangentLines[0];
    let bestDist = Infinity;
    for (const tl of tangentLines) {
      const midX = (tl.x1 + tl.x2) / 2;
      const midY = (tl.y1 + tl.y2) / 2;
      const d = Math.hypot(rawPos.x - midX, rawPos.y - midY);
      if (d < bestDist) {
        bestDist = d;
        bestLine = tl;
      }
    }

    const lineId = this._generateId();
    store.execute(this._addGeometry({
      type: "line",
      id: lineId,
      x1: bestLine.x1,
      y1: bestLine.y1,
      x2: bestLine.x2,
      y2: bestLine.y2,
    }));

    this._reset();
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.hitRadius;
    const hitId = store.hitTest(rawPos, hitRadius);

    if (!this._firstElement) {
      // 호버 하이라이트
      if (hitId) {
        const geom = store.geometries.get(hitId);
        if (geom && this._extractCircleInfo(geom)) {
          this.previews = [{ ...geom, id: `__btl_hl_${geom.id}__` }];
        } else {
          this.previews = [];
        }
      } else {
        this.previews = [];
      }
    } else {
      // 첫 요소 선택 후: 접선 프리뷰
      const firstGeom = store.geometries.get(this._firstElement.geomId);
      if (!firstGeom) {
        this._reset();
        return;
      }

      this.previews = [{ ...firstGeom, id: `__btl_hl_${firstGeom.id}__` }];

      if (hitId) {
        const geom = store.geometries.get(hitId);
        if (geom) {
          const circleInfo = this._extractCircleInfo(geom);
          if (circleInfo && circleInfo.geomId !== this._firstElement.geomId) {
            this.previews.push({ ...geom, id: `__btl_hl_${geom.id}__` });

            // 접선 프리뷰
            const tangentLines = this._computeExternalTangentLines(this._firstElement, circleInfo);
            if (tangentLines.length > 0) {
              // 커서에 가장 가까운 접선
              let bestLine = tangentLines[0];
              let bestDist = Infinity;
              for (const tl of tangentLines) {
                const midX = (tl.x1 + tl.x2) / 2;
                const midY = (tl.y1 + tl.y2) / 2;
                const d = Math.hypot(rawPos.x - midX, rawPos.y - midY);
                if (d < bestDist) {
                  bestDist = d;
                  bestLine = tl;
                }
              }
              this.preview = {
                type: "line",
                id: "__preview__",
                x1: bestLine.x1,
                y1: bestLine.y1,
                x2: bestLine.x2,
                y2: bestLine.y2,
              };
            } else {
              this.preview = null;
            }
          }
        }
      } else {
        this.preview = null;
      }
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  hasPendingWork(): boolean {
    return this._firstElement !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  override applyInputValues(
    _store: SketchGeometryStore,
    _values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    return false;
  }

  cancel(): void {
    super.cancel();
    this._reset();
  }

  // circle/arc에서 중심과 반지름 추출
  private _extractCircleInfo(geom: SerializedGeometry): CircleInfo | null {
    if (geom.type === "circle") {
      return { cx: geom.cx, cy: geom.cy, r: geom.r, geomId: geom.id };
    }
    if (geom.type === "arc") {
      return { cx: geom.cx, cy: geom.cy, r: geom.r, geomId: geom.id };
    }
    return null;
  }

  // 두 원의 외접선/내접선 계산
  private _computeExternalTangentLines(
    c1: CircleInfo,
    c2: CircleInfo,
  ): { x1: number; y1: number; x2: number; y2: number }[] {
    const results: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const dx = c2.cx - c1.cx;
    const dy = c2.cy - c1.cy;
    const d = Math.hypot(dx, dy);

    if (d < 1e-9) return results;

    // 외접선: r1 - r2 (또는 r2 - r1)
    for (const sign of [1, -1]) {
      const rDiff = c1.r - sign * c2.r;
      if (Math.abs(rDiff) > d) continue;

      const angle = Math.acos(Math.max(-1, Math.min(1, rDiff / d)));
      const baseAngle = Math.atan2(dy, dx);

      for (const dir of [1, -1]) {
        const alpha = baseAngle + dir * angle;
        const nx = Math.cos(alpha + Math.PI / 2);
        const ny = Math.sin(alpha + Math.PI / 2);

        const x1 = c1.cx + nx * c1.r;
        const y1 = c1.cy + ny * c1.r;
        const x2 = c2.cx + nx * sign * c2.r;
        const y2 = c2.cy + ny * sign * c2.r;

        results.push({ x1, y1, x2, y2 });
      }
    }

    return results;
  }

  private _reset(): void {
    this._firstElement = null;
    this.preview = null;
    this.previews = [];
  }
}
