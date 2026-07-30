// 곡선에 수직인 직선 도구 (Line Normal to Curve)
// 곡선 위의 점을 클릭하면 해당 점에서 곡선에 수직인 직선 생성
// line → 수직방향, circle/arc → 반지름 방향

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// 법선 길이
const NORMAL_LENGTH = 50;

export class LineNormalToCurveDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "line-normal";


  selectionOnly = true;
  // 법선 길이 (외부에서 변경 가능)
  normalLength = NORMAL_LENGTH;

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

    const normal = this._computeNormalAt(geom, rawPos);
    if (!normal) return;

    const lineId = this._generateId();
    store.execute(this._addGeometry({
      type: "line",
      id: lineId,
      x1: normal.px,
      y1: normal.py,
      x2: normal.px + normal.nx * this.normalLength,
      y2: normal.py + normal.ny * this.normalLength,
    }));

    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.hitRadius;
    const hitId = store.hitTest(rawPos, hitRadius);

    if (hitId) {
      const geom = store.geometries.get(hitId);
      if (geom) {
        this.previews = [{ ...geom, id: `__lnc_hl_${geom.id}__` }];

        const normal = this._computeNormalAt(geom, rawPos);
        if (normal) {
          this.preview = {
            type: "line",
            id: "__preview__",
            x1: normal.px,
            y1: normal.py,
            x2: normal.px + normal.nx * this.normalLength,
            y2: normal.py + normal.ny * this.normalLength,
          };
        } else {
          this.preview = null;
        }
      } else {
        this.previews = [];
        this.preview = null;
      }
    } else {
      this.previews = [];
      this.preview = null;
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  hasPendingWork(): boolean {
    return false;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: this.normalLength },
    ];
  }

  override applyInputValues(
    _store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (values.L !== undefined && values.L > 0) {
      this.normalLength = values.L;
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
  }

  // 곡선 위의 점에서 법선 벡터 계산
  private _computeNormalAt(
    geom: SerializedGeometry,
    pos: { x: number; y: number },
  ): { px: number; py: number; nx: number; ny: number } | null {
    switch (geom.type) {
      case "line": {
        // 직선에 대한 수직선: 가장 가까운 점에서 수직 방향
        const dx = geom.x2 - geom.x1;
        const dy = geom.y2 - geom.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return null;

        // 직선 위의 가장 가까운 점
        const t = Math.max(0, Math.min(1,
          ((pos.x - geom.x1) * dx + (pos.y - geom.y1) * dy) / (len * len),
        ));
        const px = geom.x1 + t * dx;
        const py = geom.y1 + t * dy;

        // 수직 방향 (좌측 법선)
        const nx = -dy / len;
        const ny = dx / len;

        // 커서 쪽으로 방향 결정
        const dot = (pos.x - px) * nx + (pos.y - py) * ny;
        const sign = dot >= 0 ? 1 : -1;

        return { px, py, nx: nx * sign, ny: ny * sign };
      }
      case "circle":
      case "arc": {
        // 원/호: 중심에서 커서 방향 = 반지름 방향 = 법선
        const dx = pos.x - geom.cx;
        const dy = pos.y - geom.cy;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-9) return null;

        const nx = dx / dist;
        const ny = dy / dist;

        // 원 둘레 위의 점
        const px = geom.cx + nx * geom.r;
        const py = geom.cy + ny * geom.r;

        return { px, py, nx, ny };
      }
      default:
        return null;
    }
  }
}
