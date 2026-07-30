// 3점 원 그리기 도구: 3클릭 — 원 위의 3점으로 외접원 생성
// 두 현의 수직이등분선 교점 = 중심, 3점까지의 거리 = 반지름

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class ThreePointCircleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "three-point-circle";

  private _points: { x: number; y: number }[] = [];
  private _snaps: SnapResult[] = [];
  private _step: 0 | 1 | 2 = 0; // 0: 첫째 점, 1: 둘째 점, 2: 셋째 점

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._step === 0) {
      this._points.push({ ...snappedPos });
      this._snaps.push(store.snapResult);
      this._step = 1;
    } else if (this._step === 1) {
      this._points.push({ ...snappedPos });
      this._snaps.push(store.snapResult);
      this._step = 2;
    } else if (this._step === 2) {
      this._points.push({ ...snappedPos });
      this._snaps.push(store.snapResult);

      // 3점 외접원 계산
      const result = this._circumscribedCircle(this._points[0], this._points[1], this._points[2]);
      if (result) {
        const circleId = this._generateId();
        const addCmd = this._addGeometry({
          type: "circle",
          id: circleId,
          cx: result.cx,
          cy: result.cy,
          r: result.r,
        });

        // 3점이 기존 기하 endpoint에 스냅 → 해당 점을 원 위에 구속 (center coincident 아님)
        const autoConstraintCmds: GeometryCommand[] = [];
        // 3-Point Circle은 center auto-constraint를 생성하지 않음
        // (3점이 이미 원을 결정하므로 추가 구속 불필요)

        if (autoConstraintCmds.length > 0) {
          store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
        } else {
          store.execute(addCmd);
        }
      }

      this._reset();
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 기하 기반 추론선
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (this._points.length >= 2) {
      // 3점 외접원 프리뷰
      const result = this._circumscribedCircle(this._points[0], this._points[1], snappedPos);
      if (result) {
        this.preview = {
          type: "circle",
          id: "__preview__",
          cx: result.cx,
          cy: result.cy,
          r: result.r,
        };
      } else {
        this.preview = null;
      }
    } else if (this._points.length === 1) {
      // 2점 사이 선분 프리뷰 (보조)
      this.previews = [
        { type: "line", id: "__preview_aux__", x1: this._points[0].x, y1: this._points[0].y, x2: snappedPos.x, y2: snappedPos.y },
      ];
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식이므로 pointerUp에서는 처리 없음
  }

  hasPendingWork(): boolean {
    return this._step > 0;
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

  cancel(): void {
    super.cancel();
    this._reset();
  }

  // 3점 외접원 계산 (수직이등분선 교점 방식)
  private _circumscribedCircle(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ): { cx: number; cy: number; r: number } | null {
    const ax = p1.x, ay = p1.y;
    const bx = p2.x, by = p2.y;
    const cx = p3.x, cy = p3.y;

    // 행렬식 D = 2 * (ax(by - cy) + bx(cy - ay) + cx(ay - by))
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-10) return null; // 3점이 동일선상 (퇴화)

    const ax2 = ax * ax + ay * ay;
    const bx2 = bx * bx + by * by;
    const cx2 = cx * cx + cy * cy;

    const ux = (ax2 * (by - cy) + bx2 * (cy - ay) + cx2 * (ay - by)) / D;
    const uy = (ax2 * (cx - bx) + bx2 * (ax - cx) + cx2 * (bx - ax)) / D;
    const r = Math.hypot(ax - ux, ay - uy);

    if (r < 0.1) return null; // 너무 작은 원 무시
    return { cx: ux, cy: uy, r };
  }

  private _reset(): void {
    this._points = [];
    this._snaps = [];
    this._step = 0;
    this.preview = null;
    this.previews = [];
  }
}
