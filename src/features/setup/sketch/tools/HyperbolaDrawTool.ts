// 쌍곡선(Hyperbola) 그리기 도구: 3클릭 — 중심 → 꼭짓점 (a축 결정) → 곡선 위 점 (b축 결정)
// 결과: NURBS 곡선 (쌍곡선 한 가지의 근사)
// 파라메트릭: x = a*cosh(t), y = b*sinh(t), 중심-꼭짓점 각도로 회전

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type HyperbolaState = "idle" | "vertex" | "curve-point";

// 쌍곡선 NURBS 근사 제어점 수
const NUM_POINTS = 21;
// 파라미터 범위 (t ∈ [-T_MAX, T_MAX])
const T_MAX = 2.0;

export class HyperbolaDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "hyperbola";

  private _state: HyperbolaState = "idle";
  private _center: { x: number; y: number } | null = null;
  private _vertex: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      this._recordSnap(store);
      this._center = { ...snappedPos };
      this._state = "vertex";
    } else if (this._state === "vertex") {
      if (!this._center) return;
      const dist = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (dist < 0.1) return;
      this._recordSnap(store);
      this._vertex = { ...snappedPos };
      this._state = "curve-point";
    } else if (this._state === "curve-point") {
      if (!this._center || !this._vertex) return;
      this._recordSnap(store);
      this._finalize(store, snappedPos);
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (this._state === "vertex" && this._center) {
      // 중심→꼭짓점 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._center.x,
        y1: this._center.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };
      this.previews = [];
    } else if (this._state === "curve-point" && this._center && this._vertex) {
      const b = this._computeB(this._center, this._vertex, snappedPos);
      const points = this._generateHyperbolaPoints(this._center, this._vertex, b);
      this.preview = {
        type: "curve",
        id: "__preview__",
        points,
        degree: 3,
      };
      this.previews = [];
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  hasPendingWork(): boolean {
    return this._state !== "idle";
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    const r = this._center && mousePos && this._state === "vertex"
      ? Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y)
      : this._center && this._vertex
        ? Math.hypot(this._vertex.x - this._center.x, this._vertex.y - this._center.y)
        : undefined;
    const a = this._center && this._vertex
      ? Math.atan2(this._vertex.y - this._center.y, this._vertex.x - this._center.x) * 180 / Math.PI
      : this._center && mousePos && this._state === "vertex"
        ? Math.atan2(mousePos.y - this._center.y, mousePos.x - this._center.x) * 180 / Math.PI
        : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "R", label: "R", value: r },
      { type: "A", label: "A", value: a },
    ];
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._center = null;
    this._vertex = null;
  }

  // --- 내부 ---

  // 곡선 위 점에서 b축 값 계산
  private _computeB(
    center: { x: number; y: number },
    vertex: { x: number; y: number },
    curvePoint: { x: number; y: number },
  ): number {
    const a = Math.hypot(vertex.x - center.x, vertex.y - center.y);
    const angle = Math.atan2(vertex.y - center.y, vertex.x - center.x);
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);

    // 곡선 위 점을 로컬 좌표로 변환
    const lx = (curvePoint.x - center.x) * cosA - (curvePoint.y - center.y) * sinA;
    const ly = (curvePoint.x - center.x) * sinA + (curvePoint.y - center.y) * cosA;

    // x = a*cosh(t) → cosh(t) = lx/a
    if (a < 1e-9) return 1;
    const coshT = Math.abs(lx) / a;
    if (coshT < 1.001) return Math.abs(ly) || 1; // 꼭짓점 근처: b = |ly|
    const sinhT = Math.sqrt(coshT * coshT - 1);
    if (sinhT < 1e-9) return Math.abs(ly) || 1;
    return Math.abs(ly) / sinhT;
  }

  // 쌍곡선 NURBS 제어점 생성
  private _generateHyperbolaPoints(
    center: { x: number; y: number },
    vertex: { x: number; y: number },
    b: number,
  ): { x: number; y: number }[] {
    const a = Math.hypot(vertex.x - center.x, vertex.y - center.y);
    const angle = Math.atan2(vertex.y - center.y, vertex.x - center.x);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const bVal = Math.max(b, 0.1);

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      const t = -T_MAX + (2 * T_MAX * i) / (NUM_POINTS - 1);
      const lx = a * Math.cosh(t);
      const ly = bVal * Math.sinh(t);
      // 로컬→월드 변환
      const wx = center.x + lx * cosA - ly * sinA;
      const wy = center.y + lx * sinA + ly * cosA;
      points.push({ x: wx, y: wy });
    }
    return points;
  }

  private _finalize(
    store: SketchGeometryStore,
    curvePoint: { x: number; y: number },
  ): void {
    if (!this._center || !this._vertex) return;

    const b = this._computeB(this._center, this._vertex, curvePoint);
    if (b < 0.01) {
      this.cancel();
      return;
    }

    const points = this._generateHyperbolaPoints(this._center, this._vertex, b);
    const curveId = this._generateId();
    const addCmd = this._addGeometry({
      type: "curve",
      id: curveId,
      points,
      degree: 3,
    });

    // auto-constraint (시작/끝점)
    const autoConstraintCmds: GeometryCommand[] = [];
    const startCst = this._buildAutoConstraint(store, curveId, 0, this._snapPerClick[0]);
    if (startCst) autoConstraintCmds.push(startCst);

    if (autoConstraintCmds.length > 0) {
      store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
    } else {
      store.execute(addCmd);
    }

    this.cancel();
    store.requestRender();
  }
}
