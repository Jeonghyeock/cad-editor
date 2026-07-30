// 호 그리기 도구: 3클릭 — 중심 → 시작점(반지름+각도) → 끝점(호 완성)
// 중심 스냅 시 auto-coincident 구속을 BatchCommand로 원자적 undo

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// 퇴화 호 최소 각도 (약 0.57°)
const MIN_ARC_ANGLE_DIFF = 0.01;

export class ArcDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "arc";

  private _center: { x: number; y: number } | null = null;
  private _centerSnap: SnapResult = null;
  private _startSnap: SnapResult = null;
  private _radius = 0;
  private _startAngle = 0;
  private _step: 0 | 1 | 2 = 0; // 0: 중심 대기, 1: 시작점 대기, 2: 끝점 대기

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._step === 0) {
      // 첫 클릭: 중심 설정 + 스냅 정보 캡처
      this._center = { ...snappedPos };
      this._centerSnap = store.snapResult;
      this._step = 1;
    } else if (this._step === 1 && this._center) {
      // 두 번째 클릭: 반지름 + 시작 각도 확정
      this._radius = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (this._radius < 0.1) return; // 너무 작으면 무시
      this._startAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      this._startSnap = store.snapResult;
      this._step = 2;
    } else if (this._step === 2 && this._center) {
      // 세 번째 클릭: 호 확정
      const endSnap = store.snapResult;
      const endAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      // 퇴화 호 방지 (시작각 ≈ 끝각)
      let angleDiff = Math.abs(endAngle - this._startAngle);
      if (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;
      if (angleDiff < MIN_ARC_ANGLE_DIFF) return;

      const arcId = this._generateId();
      const addCmd = this._addGeometry({
        type: "arc",
        id: arcId,
        cx: this._center.x,
        cy: this._center.y,
        r: this._radius,
        startAngle: this._startAngle,
        endAngle,
      });

      // auto-coincident 구속: center(0), start(1), end(2)
      const autoConstraintCmds: GeometryCommand[] = [];
      const centerCst = this._buildAutoConstraint(store, arcId, 0, this._centerSnap);
      if (centerCst) autoConstraintCmds.push(centerCst);
      const startCst = this._buildAutoConstraint(store, arcId, 1, this._startSnap);
      if (startCst) autoConstraintCmds.push(startCst);
      const endCst = this._buildAutoConstraint(store, arcId, 2, endSnap);
      if (endCst) autoConstraintCmds.push(endCst);

      if (autoConstraintCmds.length > 0) {
        store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
      } else {
        store.execute(addCmd);
      }
      this._reset();
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 기하 기반 추론선 (첫 클릭 전에도 작동)
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (!this._center) {
      store.requestRender();
      return;
    }

    if (this._step === 1) {
      // 중심에서 마우스까지 반지름 프리뷰 (원 전체로 표시)
      const r = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      this.preview = {
        type: "circle",
        id: "__preview__",
        cx: this._center.x,
        cy: this._center.y,
        r,
      };
    } else if (this._step === 2) {
      // 시작각에서 현재각까지 호 프리뷰
      const endAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      this.preview = {
        type: "arc",
        id: "__preview__",
        cx: this._center.x,
        cy: this._center.y,
        r: this._radius,
        startAngle: this._startAngle,
        endAngle,
      };
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
    // R: 반지름 (step >= 1), A: 끝각도 (step === 2)
    let r: number | undefined;
    let a: number | undefined;
    if (this._step === 1 && this._center && mousePos) {
      r = Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y);
    } else if (this._step === 2 && this._center && mousePos) {
      r = this._radius;
      a = Math.atan2(mousePos.y - this._center.y, mousePos.x - this._center.x) * 180 / Math.PI;
    }
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "R", label: "R", value: r },
      { type: "A", label: "A", value: a },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (this._step === 0) {
      // 중심 설정: H/V 필요
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._step === 1 && this._center) {
      // 반지름 설정: R 또는 H/V
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
    if (this._step === 2 && this._center) {
      // 끝각도 설정: A 또는 H/V
      if (values.A !== undefined) {
        const rad = values.A * Math.PI / 180;
        this.onPointerDown(store, {
          x: this._center.x + this._radius * Math.cos(rad),
          y: this._center.y + this._radius * Math.sin(rad),
        }, {
          x: this._center.x + this._radius * Math.cos(rad),
          y: this._center.y + this._radius * Math.sin(rad),
        });
        return true;
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
    this._reset();
  }

  private _reset(): void {
    this._center = null;
    this._centerSnap = null;
    this._startSnap = null;
    this._radius = 0;
    this._startAngle = 0;
    this._step = 0;
    this.preview = null;
  }
}
