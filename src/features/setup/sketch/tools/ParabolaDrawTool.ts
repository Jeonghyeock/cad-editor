// 포물선(Parabola) 그리기 도구: 3클릭 — 초점 → 꼭짓점 → 곡선 위 점 (개구 방향 + 폭)
// 결과: NURBS 곡선 (포물선 근사)
// 파라메트릭: x = t, y = t²/(4f), f = 초점 거리, 초점-꼭짓점 방향으로 회전

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type ParabolaState = "idle" | "vertex" | "curve-point";

// NURBS 근사 점 수
const NUM_POINTS = 21;

export class ParabolaDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "parabola";

  private _state: ParabolaState = "idle";
  private _focus: { x: number; y: number } | null = null;
  private _vertex: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      this._recordSnap(store);
      this._focus = { ...snappedPos };
      this._state = "vertex";
    } else if (this._state === "vertex") {
      if (!this._focus) return;
      const dist = Math.hypot(snappedPos.x - this._focus.x, snappedPos.y - this._focus.y);
      if (dist < 0.1) return;
      this._recordSnap(store);
      this._vertex = { ...snappedPos };
      this._state = "curve-point";
    } else if (this._state === "curve-point") {
      if (!this._focus || !this._vertex) return;
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

    if (this._state === "vertex" && this._focus) {
      // 초점→꼭짓점 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._focus.x,
        y1: this._focus.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };
      this.previews = [];
    } else if (this._state === "curve-point" && this._focus && this._vertex) {
      const tRange = this._computeTRange(this._focus, this._vertex, snappedPos);
      const points = this._generateParabolaPoints(this._focus, this._vertex, tRange);
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
    const r = this._focus && this._vertex
      ? Math.hypot(this._vertex.x - this._focus.x, this._vertex.y - this._focus.y)
      : this._focus && mousePos && this._state === "vertex"
        ? Math.hypot(mousePos.x - this._focus.x, mousePos.y - this._focus.y)
        : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "R", label: "R", value: r },
    ];
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._focus = null;
    this._vertex = null;
  }

  // --- 내부 ---

  // 곡선 위 점에서 t 범위 계산 (포물선 폭 결정)
  private _computeTRange(
    focus: { x: number; y: number },
    vertex: { x: number; y: number },
    curvePoint: { x: number; y: number },
  ): number {
    const f = Math.hypot(vertex.x - focus.x, vertex.y - focus.y);
    if (f < 1e-9) return 10;

    // 축 방향: 초점→꼭짓점 반대 방향 (꼭짓점이 개구 방향)
    const angle = Math.atan2(vertex.y - focus.y, vertex.x - focus.x);
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);

    // 곡선 위 점을 꼭짓점 기준 로컬 좌표로 변환
    const dx = curvePoint.x - vertex.x;
    const dy = curvePoint.y - vertex.y;
    const ly = dx * sinA + dy * cosA;

    // y = t²/(4f) → t = sqrt(4f * |ly|) (대칭이므로 절대값)
    const tRange = Math.sqrt(4 * f * Math.abs(ly));
    return Math.max(tRange, f * 0.5); // 최소 범위 보장
  }

  // 포물선 NURBS 제어점 생성
  private _generateParabolaPoints(
    focus: { x: number; y: number },
    vertex: { x: number; y: number },
    tRange: number,
  ): { x: number; y: number }[] {
    const f = Math.hypot(vertex.x - focus.x, vertex.y - focus.y);
    if (f < 1e-9) return [{ ...vertex }];

    // 축 방향: 초점→꼭짓점 (포물선이 열리는 방향)
    const angle = Math.atan2(vertex.y - focus.y, vertex.x - focus.x);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      const t = -tRange + (2 * tRange * i) / (NUM_POINTS - 1);
      // 로컬 좌표: x축이 개구 방향
      const lx = t * t / (4 * f); // 포물선 방정식
      const ly = t;

      // 꼭짓점 기준 로컬→월드 변환
      const wx = vertex.x + lx * cosA - ly * sinA;
      const wy = vertex.y + lx * sinA + ly * cosA;
      points.push({ x: wx, y: wy });
    }
    return points;
  }

  private _finalize(
    store: SketchGeometryStore,
    curvePoint: { x: number; y: number },
  ): void {
    if (!this._focus || !this._vertex) return;

    const tRange = this._computeTRange(this._focus, this._vertex, curvePoint);
    const points = this._generateParabolaPoints(this._focus, this._vertex, tRange);

    if (points.length < 2) {
      this.cancel();
      return;
    }

    const curveId = this._generateId();
    const addCmd = this._addGeometry({
      type: "curve",
      id: curveId,
      points,
      degree: 3,
    });

    // auto-constraint
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
