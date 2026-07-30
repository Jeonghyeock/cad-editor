// 타원 그리기 도구: 3클릭 — 중심 → 장축 끝점 → 단축 끝점
// ellipse 프리미티브를 직접 생성 (cx, cy, rx, ry, rotation)

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type EllipseState = "idle" | "semi-major" | "semi-minor";

export class EllipseDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "ellipse";

  private _state: EllipseState = "idle";
  private _center: { x: number; y: number } | null = null;
  private _majorEnd: { x: number; y: number } | null = null;
  private _centerSnap: SnapResult = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      // 첫 클릭: 중심
      this._center = { ...snappedPos };
      this._centerSnap = store.snapResult;
      this._state = "semi-major";
    } else if (this._state === "semi-major") {
      // 두 번째 클릭: 장축 끝점
      if (!this._center) return;
      const dist = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (dist < 0.1) return; // 너무 작으면 무시
      this._majorEnd = { ...snappedPos };
      this._state = "semi-minor";
    } else if (this._state === "semi-minor") {
      // 세 번째 클릭: 단축 끝점 → 타원 확정
      if (!this._center || !this._majorEnd) return;
      this._finalize(store, snappedPos);
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

    if (this._state === "semi-major" && this._center) {
      // 장축 방향 프리뷰 — 임시 원으로 표시
      const r = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      this.preview = {
        type: "circle",
        id: "__preview__",
        cx: this._center.x,
        cy: this._center.y,
        r,
      };
    } else if (this._state === "semi-minor" && this._center && this._majorEnd) {
      // 타원 프리뷰 (ellipse 프리미티브)
      const params = this._computeEllipseParams(this._center, this._majorEnd, snappedPos);
      if (params) {
        this.preview = {
          type: "ellipse",
          id: "__preview__",
          cx: params.cx,
          cy: params.cy,
          rx: params.rx,
          ry: params.ry,
          rotation: params.rotation,
        };
      }
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식이므로 pointerUp에서는 처리 없음
  }

  hasPendingWork(): boolean {
    return this._state !== "idle";
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    // R: semi-major 단계에서는 장축 반지름, semi-minor 단계에서는 단축 반지름
    let r: number | undefined;
    if (this._state === "semi-major" && this._center && mousePos) {
      r = Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y);
    } else if (this._state === "semi-minor" && this._center && this._majorEnd && mousePos) {
      // 단축 반지름: 마우스를 단축 방향으로 투영
      const dx = this._majorEnd.x - this._center.x;
      const dy = this._majorEnd.y - this._center.y;
      const rx = Math.hypot(dx, dy);
      if (rx > 1e-6) {
        const vx = -dy / rx;
        const vy = dx / rx;
        const mx = mousePos.x - this._center.x;
        const my = mousePos.y - this._center.y;
        r = Math.abs(mx * vx + my * vy);
      }
    }
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "R", label: "R", value: r },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (this._state === "idle") {
      // 중심 설정: H/V
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "semi-major" && this._center) {
      // 장축 반지름: R 또는 H/V
      if (values.R !== undefined) {
        this.onPointerDown(store, { x: this._center.x + values.R, y: this._center.y }, { x: this._center.x + values.R, y: this._center.y });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "semi-minor" && this._center && this._majorEnd) {
      // 단축 반지름: R 또는 H/V
      if (values.R !== undefined) {
        // 단축 방향으로 R 거리의 점 계산
        const dx = this._majorEnd.x - this._center.x;
        const dy = this._majorEnd.y - this._center.y;
        const rx = Math.hypot(dx, dy);
        if (rx > 1e-6) {
          const vx = -dy / rx;
          const vy = dx / rx;
          this.onPointerDown(store, {
            x: this._center.x + vx * values.R,
            y: this._center.y + vy * values.R,
          }, {
            x: this._center.x + vx * values.R,
            y: this._center.y + vy * values.R,
          });
          return true;
        }
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._center = null;
    this._majorEnd = null;
    this._centerSnap = null;
  }

  // --- 내부 ---

  private _finalize(
    store: SketchGeometryStore,
    minorEnd: { x: number; y: number },
  ): void {
    if (!this._center || !this._majorEnd) return;

    const params = this._computeEllipseParams(this._center, this._majorEnd, minorEnd);
    if (!params) {
      this.cancel();
      return;
    }

    const ellipseId = this._generateId();
    const addCmd = this._addGeometry({
      type: "ellipse",
      id: ellipseId,
      cx: params.cx,
      cy: params.cy,
      rx: params.rx,
      ry: params.ry,
      rotation: params.rotation,
    });

    // 중심 auto-coincident 구속 (vertex 0 = center)
    const autoConstraintCmds: GeometryCommand[] = [];
    const cst = this._buildAutoConstraint(store, ellipseId, 0, this._centerSnap);
    if (cst) autoConstraintCmds.push(cst);

    if (autoConstraintCmds.length > 0) {
      store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
    } else {
      store.execute(addCmd);
    }

    this.cancel();
    store.requestRender();
  }

  // 타원 파라미터 계산 (cx, cy, rx, ry, rotation)
  private _computeEllipseParams(
    center: { x: number; y: number },
    majorEnd: { x: number; y: number },
    minorEnd: { x: number; y: number },
  ): { cx: number; cy: number; rx: number; ry: number; rotation: number } | null {
    // 장축 반지름 & 방향
    const dx = majorEnd.x - center.x;
    const dy = majorEnd.y - center.y;
    const rx = Math.hypot(dx, dy);
    if (rx < 1e-6) return null;

    // 장축 방향 단위 벡터
    const ux = dx / rx;
    const uy = dy / rx;

    // 단축 방향 단위 벡터 (장축에 수직)
    const vx = -uy;
    const vy = ux;

    // 단축 반지름: minorEnd를 단축 방향으로 투영
    const mx = minorEnd.x - center.x;
    const my = minorEnd.y - center.y;
    const ry = Math.abs(mx * vx + my * vy);
    if (ry < 1e-6) return null;

    // 장축 방향의 회전 각도
    const rotation = Math.atan2(uy, ux);

    return { cx: center.x, cy: center.y, rx, ry, rotation };
  }
}
