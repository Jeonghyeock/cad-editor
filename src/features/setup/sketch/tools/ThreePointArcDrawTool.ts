// 3점 호 그리기 도구: 3클릭 — 시작점 → 중간점 → 끝점
// 3점 외접원 계산 후 시작~끝 각도의 arc 생성, 중간점이 호 위에 있도록 방향 결정

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class ThreePointArcDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "three-point-arc";

  private _points: { x: number; y: number }[] = [];
  private _snaps: SnapResult[] = [];
  private _step: 0 | 1 | 2 = 0; // 0: 시작점, 1: 중간점, 2: 끝점

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

      // 3점 외접원 + 호 각도 계산
      const arcData = this._computeArc(this._points[0], this._points[1], this._points[2]);
      if (arcData) {
        const arcId = this._generateId();
        const addCmd = this._addGeometry({
          type: "arc",
          id: arcId,
          cx: arcData.cx,
          cy: arcData.cy,
          r: arcData.r,
          startAngle: arcData.startAngle,
          endAngle: arcData.endAngle,
        });

        // 시작점/끝점 auto-coincident 구속 생성
        // arc vertex 0 = center, 1 = start endpoint, 2 = end endpoint
        const autoConstraintCmds: GeometryCommand[] = [];
        const startCst = this._buildAutoConstraint(store, arcId, 1, this._snaps[0]);
        if (startCst) autoConstraintCmds.push(startCst);
        const endCst = this._buildAutoConstraint(store, arcId, 2, this._snaps[2]);
        if (endCst) autoConstraintCmds.push(endCst);

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

    if (this._points.length === 2) {
      // 3점 호 프리뷰
      const arcData = this._computeArc(this._points[0], this._points[1], snappedPos);
      if (arcData) {
        this.preview = {
          type: "arc",
          id: "__preview__",
          cx: arcData.cx,
          cy: arcData.cy,
          r: arcData.r,
          startAngle: arcData.startAngle,
          endAngle: arcData.endAngle,
        };
      } else {
        this.preview = null;
      }
    } else if (this._points.length === 1) {
      // 시작점~현재점 보조 선분 프리뷰
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

  // 3점 외접원 + 호 각도 계산
  private _computeArc(
    pStart: { x: number; y: number },
    pMid: { x: number; y: number },
    pEnd: { x: number; y: number },
  ): { cx: number; cy: number; r: number; startAngle: number; endAngle: number } | null {
    // 외접원 중심 계산
    const ax = pStart.x, ay = pStart.y;
    const bx = pMid.x, by = pMid.y;
    const cx = pEnd.x, cy = pEnd.y;

    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-10) return null; // 동일선상

    const ax2 = ax * ax + ay * ay;
    const bx2 = bx * bx + by * by;
    const cx2 = cx * cx + cy * cy;

    const ux = (ax2 * (by - cy) + bx2 * (cy - ay) + cx2 * (ay - by)) / D;
    const uy = (ax2 * (cx - bx) + bx2 * (ax - cx) + cx2 * (bx - ax)) / D;
    const r = Math.hypot(ax - ux, ay - uy);

    if (r < 0.1) return null;

    // 각도 계산
    const startAngle = Math.atan2(ay - uy, ax - ux);
    const midAngle = Math.atan2(by - uy, bx - ux);
    const endAngle = Math.atan2(cy - uy, cx - ux);

    // 중간점이 호 위에 있도록 방향 결정
    // 시작→끝 방향으로 진행할 때 중간점이 포함되는지 확인
    if (this._isAngleBetween(midAngle, startAngle, endAngle)) {
      return { cx: ux, cy: uy, r, startAngle, endAngle };
    } else {
      // 방향 반전: 끝점과 시작점을 교환
      return { cx: ux, cy: uy, r, startAngle: endAngle, endAngle: startAngle };
    }
  }

  // 각도 between 판정 (반시계 방향 기준)
  private _isAngleBetween(mid: number, start: number, end: number): boolean {
    // 모든 각도를 [0, 2pi) 범위로 정규화
    const TWO_PI = Math.PI * 2;
    const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
    const s = normalize(start);
    const m = normalize(mid);
    const e = normalize(end);

    // start→end 반시계 방향 아크에 mid가 포함되는지 확인
    const sweep = ((e - s) + TWO_PI) % TWO_PI;
    const toMid = ((m - s) + TWO_PI) % TWO_PI;
    return toMid <= sweep;
  }

  private _reset(): void {
    this._points = [];
    this._snaps = [];
    this._step = 0;
    this.preview = null;
    this.previews = [];
  }
}
