// 사다리꼴(Trapezoid) 그리기 도구: 3클릭 — 밑변 시작 → 밑변 끝 → 윗변 점 (높이 + 윗변 폭)
// 결과: 4 line + 4 coincident + 1 parallel (윗변 ∥ 밑변)
// BatchCommand로 원자적 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SnapVertexMapping } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type TrapState = "idle" | "base-end" | "top";

export class TrapezoidDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "trapezoid";

  private _state: TrapState = "idle";
  private _baseStart: { x: number; y: number } | null = null;
  private _baseEnd: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      this._recordSnap(store);
      this._baseStart = { ...snappedPos };
      this._state = "base-end";
    } else if (this._state === "base-end") {
      if (!this._baseStart) return;
      const dist = Math.hypot(snappedPos.x - this._baseStart.x, snappedPos.y - this._baseStart.y);
      if (dist < 0.1) return;
      this._recordSnap(store);
      this._baseEnd = { ...snappedPos };
      this._state = "top";
    } else if (this._state === "top") {
      if (!this._baseStart || !this._baseEnd) return;
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

    if (this._state === "base-end" && this._baseStart) {
      // 밑변 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._baseStart.x,
        y1: this._baseStart.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
      };
      this.previews = [];
    } else if (this._state === "top" && this._baseStart && this._baseEnd) {
      // 사다리꼴 프리뷰
      const { vertices } = this._computeTrapezoid(this._baseStart, this._baseEnd, snappedPos);
      this.previews = [
        { type: "line", id: "__trap_0__", x1: vertices[0].x, y1: vertices[0].y, x2: vertices[1].x, y2: vertices[1].y },
        { type: "line", id: "__trap_1__", x1: vertices[1].x, y1: vertices[1].y, x2: vertices[2].x, y2: vertices[2].y },
        { type: "line", id: "__trap_2__", x1: vertices[2].x, y1: vertices[2].y, x2: vertices[3].x, y2: vertices[3].y },
        { type: "line", id: "__trap_3__", x1: vertices[3].x, y1: vertices[3].y, x2: vertices[0].x, y2: vertices[0].y },
      ];
      this.preview = null;
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
    const l = this._baseStart && mousePos && this._state === "base-end"
      ? Math.hypot(mousePos.x - this._baseStart.x, mousePos.y - this._baseStart.y)
      : this._baseStart && this._baseEnd
        ? Math.hypot(this._baseEnd.x - this._baseStart.x, this._baseEnd.y - this._baseStart.y)
        : undefined;
    const a = this._baseStart && mousePos && this._state === "base-end"
      ? Math.atan2(mousePos.y - this._baseStart.y, mousePos.x - this._baseStart.x) * 180 / Math.PI
      : this._baseStart && this._baseEnd
        ? Math.atan2(this._baseEnd.y - this._baseStart.y, this._baseEnd.x - this._baseStart.x) * 180 / Math.PI
        : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: l },
      { type: "A", label: "A", value: a },
    ];
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._baseStart = null;
    this._baseEnd = null;
  }

  // --- 내부 ---

  // 사다리꼴 꼭짓점 계산
  // mousePos를 밑변 법선 방향으로 투영하여 높이 결정, 축 방향 투영으로 윗변 반폭 결정
  private _computeTrapezoid(
    baseStart: { x: number; y: number },
    baseEnd: { x: number; y: number },
    mousePos: { x: number; y: number },
  ): { vertices: { x: number; y: number }[] } {
    const dx = baseEnd.x - baseStart.x;
    const dy = baseEnd.y - baseStart.y;
    const baseLen = Math.hypot(dx, dy);
    if (baseLen < 1e-9) return { vertices: [baseStart, baseEnd, baseEnd, baseStart] };

    // 밑변 단위 벡터
    const ux = dx / baseLen;
    const uy = dy / baseLen;
    // 법선 (밑변에 수직, 왼쪽 방향)
    const nx = -uy;
    const ny = ux;

    // 밑변 중점에서 마우스까지 벡터
    const midX = (baseStart.x + baseEnd.x) / 2;
    const midY = (baseStart.y + baseEnd.y) / 2;
    const mx = mousePos.x - midX;
    const my = mousePos.y - midY;

    // 높이: 법선 방향 투영
    const height = mx * nx + my * ny;
    // 윗변 반폭: 축 방향 투영 (마우스 x 위치로 윗변 폭 결정)
    const topHalfWidth = Math.abs(mx * ux + my * uy);

    // 꼭짓점 (CCW): baseStart → baseEnd → topRight → topLeft
    const topCenter = { x: midX + nx * height, y: midY + ny * height };
    const topRight = { x: topCenter.x + ux * topHalfWidth, y: topCenter.y + uy * topHalfWidth };
    const topLeft = { x: topCenter.x - ux * topHalfWidth, y: topCenter.y - uy * topHalfWidth };

    return {
      vertices: [
        { ...baseStart },
        { ...baseEnd },
        topRight,
        topLeft,
      ],
    };
  }

  private _finalize(
    store: SketchGeometryStore,
    mousePos: { x: number; y: number },
  ): void {
    if (!this._baseStart || !this._baseEnd) return;

    const { vertices } = this._computeTrapezoid(this._baseStart, this._baseEnd, mousePos);

    // 퇴화 검사: 높이가 너무 작으면 무시
    const dx = this._baseEnd.x - this._baseStart.x;
    const dy = this._baseEnd.y - this._baseStart.y;
    const baseLen = Math.hypot(dx, dy);
    const nx = -dy / baseLen;
    const ny = dx / baseLen;
    const midX = (this._baseStart.x + this._baseEnd.x) / 2;
    const midY = (this._baseStart.y + this._baseEnd.y) / 2;
    const height = Math.abs((mousePos.x - midX) * nx + (mousePos.y - midY) * ny);
    if (height < 0.1) {
      this.cancel();
      return;
    }

    const lineIds: [string, string, string, string] = [
      this._generateId(), this._generateId(),
      this._generateId(), this._generateId(),
    ];

    // 4 line: base(0→1), right(1→2), top(2→3), left(3→0)
    const geometries: SerializedGeometry[] = [
      { type: "line", id: lineIds[0], x1: vertices[0].x, y1: vertices[0].y, x2: vertices[1].x, y2: vertices[1].y },
      { type: "line", id: lineIds[1], x1: vertices[1].x, y1: vertices[1].y, x2: vertices[2].x, y2: vertices[2].y },
      { type: "line", id: lineIds[2], x1: vertices[2].x, y1: vertices[2].y, x2: vertices[3].x, y2: vertices[3].y },
      { type: "line", id: lineIds[3], x1: vertices[3].x, y1: vertices[3].y, x2: vertices[0].x, y2: vertices[0].y },
    ];

    let cIdx = 0;
    const cid = () => `cst_trap_${lineIds[0]}_${cIdx++}`;

    const constraints = [
      // 4 coincident: 순환
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[0], vertexIndex: 1 }, pointB: { geomId: lineIds[1], vertexIndex: 0 } },
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[1], vertexIndex: 1 }, pointB: { geomId: lineIds[2], vertexIndex: 0 } },
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[2], vertexIndex: 1 }, pointB: { geomId: lineIds[3], vertexIndex: 0 } },
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[3], vertexIndex: 1 }, pointB: { geomId: lineIds[0], vertexIndex: 0 } },
      // 1 parallel: top ∥ base
      { type: "parallel" as const, id: cid(), lineA: { geomId: lineIds[0] }, lineB: { geomId: lineIds[2] } },
    ];

    const finalGeometries = this.constructionMode
      ? geometries.map((g) => ({ ...g, isConstruction: true }))
      : geometries;

    // 스냅 기반 auto-constraint
    const mappings: SnapVertexMapping[] = [
      { clickIndex: 0, geomId: lineIds[0], vertexIndex: 0 }, // baseStart
      { clickIndex: 1, geomId: lineIds[0], vertexIndex: 1 }, // baseEnd
    ];
    const autoCmds = this._buildSnapConstraints(store, mappings);

    const mainCmd = new AddRectangleCommand(finalGeometries, constraints);
    if (autoCmds.length > 0) {
      store.execute(new BatchCommand([mainCmd, ...autoCmds]));
    } else {
      store.execute(mainCmd);
    }
    this.cancel();
    store.requestRender();
  }
}
