// 무한 직선 도구 (Infinite Line / Construction Line)
// 3가지 모드: Horizontal, Vertical, 2-point
// ±10000 단위의 매우 긴 construction line 생성

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// 무한 선의 반 길이 (충분히 긴 construction line)
const INFINITE_HALF = 10000;

type InfiniteLineMode = "horizontal" | "vertical" | "two-point";

export class InfiniteLineDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "infinite-line";

  // 현재 모드 (외부에서 변경 가능, SketchToolsPanel 연동)
  mode: InfiniteLineMode = "two-point";

  private _startPos: { x: number; y: number } | null = null;
  private _startSnap: SnapResult = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this.mode === "horizontal") {
      // 수평 무한선: y좌표만 사용
      this._createHorizontalLine(store, snappedPos.y);
      return;
    }
    if (this.mode === "vertical") {
      // 수직 무한선: x좌표만 사용
      this._createVerticalLine(store, snappedPos.x);
      return;
    }

    // 2-point 모드
    if (!this._startPos) {
      this._startPos = { ...snappedPos };
      this._startSnap = store.snapResult;
    } else {
      const dx = snappedPos.x - this._startPos.x;
      const dy = snappedPos.y - this._startPos.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.1) return;

      // 방향 벡터 정규화 후 무한 확장
      const nx = dx / len;
      const ny = dy / len;
      const mid = {
        x: (this._startPos.x + snappedPos.x) / 2,
        y: (this._startPos.y + snappedPos.y) / 2,
      };

      const lineId = this._generateId();
      const addCmd = this._addGeometry({
        type: "line",
        id: lineId,
        x1: mid.x - nx * INFINITE_HALF,
        y1: mid.y - ny * INFINITE_HALF,
        x2: mid.x + nx * INFINITE_HALF,
        y2: mid.y + ny * INFINITE_HALF,
        isConstruction: true,
      });

      // 시작점 auto-coincident
      const autoConstraintCmds: GeometryCommand[] = [];
      const startCst = this._buildAutoConstraint(store, lineId, 0, this._startSnap);
      if (startCst) autoConstraintCmds.push(startCst);

      if (autoConstraintCmds.length > 0) {
        store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
      } else {
        store.execute(addCmd);
      }

      this._startPos = null;
      this._startSnap = null;
      this.preview = null;
      this.inferenceLines = [];
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const geometries = [...store.geometries.values()];

    if (this.mode === "horizontal") {
      // 수평 무한선 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: -INFINITE_HALF,
        y1: snappedPos.y,
        x2: INFINITE_HALF,
        y2: snappedPos.y,
        isConstruction: true,
      };
    } else if (this.mode === "vertical") {
      // 수직 무한선 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: snappedPos.x,
        y1: -INFINITE_HALF,
        x2: snappedPos.x,
        y2: INFINITE_HALF,
        isConstruction: true,
      };
    } else if (this._startPos) {
      // 2-point 모드: 방향 기반 무한선 프리뷰
      const dx = snappedPos.x - this._startPos.x;
      const dy = snappedPos.y - this._startPos.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.1) {
        const nx = dx / len;
        const ny = dy / len;
        const mid = {
          x: (this._startPos.x + snappedPos.x) / 2,
          y: (this._startPos.y + snappedPos.y) / 2,
        };
        this.preview = {
          type: "line",
          id: "__preview__",
          x1: mid.x - nx * INFINITE_HALF,
          y1: mid.y - ny * INFINITE_HALF,
          x2: mid.x + nx * INFINITE_HALF,
          y2: mid.y + ny * INFINITE_HALF,
          isConstruction: true,
        };
      }
    } else {
      this.preview = null;
    }

    // 추론선
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식이므로 pointerUp 처리 없음
  }

  hasPendingWork(): boolean {
    return this._startPos !== null;
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
    if (this.mode === "horizontal" && values.V !== undefined) {
      this._createHorizontalLine(store, values.V);
      return true;
    }
    if (this.mode === "vertical" && values.H !== undefined) {
      this._createVerticalLine(store, values.H);
      return true;
    }
    if (values.H !== undefined && values.V !== undefined) {
      this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._startPos = null;
    this._startSnap = null;
  }

  // 수평 무한선 생성
  private _createHorizontalLine(store: SketchGeometryStore, y: number): void {
    const lineId = this._generateId();
    const addCmd = this._addGeometry({
      type: "line",
      id: lineId,
      x1: -INFINITE_HALF,
      y1: y,
      x2: INFINITE_HALF,
      y2: y,
      isConstruction: true,
    });
    store.execute(addCmd);
    this.preview = null;
    store.requestRender();
  }

  // 수직 무한선 생성
  private _createVerticalLine(store: SketchGeometryStore, x: number): void {
    const lineId = this._generateId();
    const addCmd = this._addGeometry({
      type: "line",
      id: lineId,
      x1: x,
      y1: -INFINITE_HALF,
      x2: x,
      y2: INFINITE_HALF,
      isConstruction: true,
    });
    store.execute(addCmd);
    this.preview = null;
    store.requestRender();
  }
}
