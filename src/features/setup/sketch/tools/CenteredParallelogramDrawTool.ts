// 중심 기준 평행사변형 그리기 도구: 3클릭 — 중심 → 첫 변 끝 → 두 번째 변 끝
// 중심으로부터 대칭으로 확장, 4 line + 4 coincident 구속

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class CenteredParallelogramDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "centered-parallelogram";

  private _center: { x: number; y: number } | null = null;
  private _edgeEnd: { x: number; y: number } | null = null;
  private _step: 0 | 1 | 2 = 0; // 0: 중심 대기, 1: 첫 변 끝 대기, 2: 두 번째 변 끝 대기

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._step === 0) {
      this._recordSnap(store);
      this._center = { ...snappedPos };
      this._step = 1;
    } else if (this._step === 1 && this._center) {
      const len = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (len < 0.1) return;
      this._recordSnap(store);
      this._edgeEnd = { ...snappedPos };
      this._step = 2;
    } else if (this._step === 2 && this._center && this._edgeEnd) {
      this._recordSnap(store);
      const corners = this._computeCorners(this._center, this._edgeEnd, snappedPos);
      if (!corners) {
        this._reset();
        return;
      }

      const lineIds: [string, string, string, string] = [
        this._generateId(), this._generateId(),
        this._generateId(), this._generateId(),
      ];

      const [c0, c1, c2, c3] = corners;
      const geometries: SerializedGeometry[] = [
        { type: "line", id: lineIds[0], x1: c0.x, y1: c0.y, x2: c1.x, y2: c1.y },
        { type: "line", id: lineIds[1], x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y },
        { type: "line", id: lineIds[2], x1: c2.x, y1: c2.y, x2: c3.x, y2: c3.y },
        { type: "line", id: lineIds[3], x1: c3.x, y1: c3.y, x2: c0.x, y2: c0.y },
      ];

      let cIdx = 0;
      const cid = () => `cst_${lineIds[0]}_${cIdx++}`;

      const constraints = [
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[0], vertexIndex: 1 }, pointB: { geomId: lineIds[1], vertexIndex: 0 } },
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[1], vertexIndex: 1 }, pointB: { geomId: lineIds[2], vertexIndex: 0 } },
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[2], vertexIndex: 1 }, pointB: { geomId: lineIds[3], vertexIndex: 0 } },
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[3], vertexIndex: 1 }, pointB: { geomId: lineIds[0], vertexIndex: 0 } },
        // Parallel: 대변 평행
        { type: "parallel" as const, id: cid(), lineA: { geomId: lineIds[0] }, lineB: { geomId: lineIds[2] } },
        { type: "parallel" as const, id: cid(), lineA: { geomId: lineIds[1] }, lineB: { geomId: lineIds[3] } },
        // Equal: 대변 같은 길이
        { type: "equal" as const, id: cid(), lineA: { geomId: lineIds[0] }, lineB: { geomId: lineIds[2] } },
        { type: "equal" as const, id: cid(), lineA: { geomId: lineIds[1] }, lineB: { geomId: lineIds[3] } },
      ];

      const finalGeometries = this.constructionMode
        ? geometries.map((g) => ({ ...g, isConstruction: true }))
        : geometries;

      // Snap 기반 auto-constraint — click 0 = center (derived, vertex 매핑 X), click 1/2 = edge
      // end points. corners 가 center ± dx ± dy 형태라 직접 vertex 매핑 어려움 — _recordSnap
      // 만 보존 (향후 center point geom 추가 시 활용).
      const autoCmds = this._buildSnapConstraints(store, []);

      const mainCmd = new AddRectangleCommand(finalGeometries, constraints);
      if (autoCmds.length > 0) {
        store.execute(new BatchCommand([mainCmd, ...autoCmds]));
      } else {
        store.execute(mainCmd);
      }
      this._reset();
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

    if (this._step === 1 && this._center) {
      // 중심에서 첫 변 끝까지 프리뷰 (반대편도 표시)
      const dx = snappedPos.x - this._center.x;
      const dy = snappedPos.y - this._center.y;
      this.previews = [
        { type: "line", id: "__preview_0__",
          x1: this._center.x - dx, y1: this._center.y - dy,
          x2: this._center.x + dx, y2: this._center.y + dy },
      ];
    } else if (this._step === 2 && this._center && this._edgeEnd) {
      const corners = this._computeCorners(this._center, this._edgeEnd, snappedPos);
      if (corners) {
        const [c0, c1, c2, c3] = corners;
        this.previews = [
          { type: "line", id: "__preview_0__", x1: c0.x, y1: c0.y, x2: c1.x, y2: c1.y },
          { type: "line", id: "__preview_1__", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y },
          { type: "line", id: "__preview_2__", x1: c2.x, y1: c2.y, x2: c3.x, y2: c3.y },
          { type: "line", id: "__preview_3__", x1: c3.x, y1: c3.y, x2: c0.x, y2: c0.y },
        ];
      }
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  hasPendingWork(): boolean {
    return this._step > 0;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    // L: 중심→첫 변 끝 거리, A: 중심→첫 변 끝 각도
    const l = this._center && mousePos && this._step === 1
      ? Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y)
      : this._center && this._edgeEnd
        ? Math.hypot(this._edgeEnd.x - this._center.x, this._edgeEnd.y - this._center.y)
        : undefined;
    const a = this._center && mousePos && this._step === 1
      ? Math.atan2(mousePos.y - this._center.y, mousePos.x - this._center.x) * 180 / Math.PI
      : this._center && this._edgeEnd
        ? Math.atan2(this._edgeEnd.y - this._center.y, this._edgeEnd.x - this._center.x) * 180 / Math.PI
        : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: l },
      { type: "A", label: "A", value: a },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (this._step === 0) {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._step === 1 && this._center) {
      // L+A: 중심에서 첫 변 끝까지 극좌표
      if (values.L !== undefined && values.A !== undefined) {
        const rad = values.A * Math.PI / 180;
        this.onPointerDown(store, {
          x: this._center.x + values.L * Math.cos(rad),
          y: this._center.y + values.L * Math.sin(rad),
        }, {
          x: this._center.x + values.L * Math.cos(rad),
          y: this._center.y + values.L * Math.sin(rad),
        });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._step === 2 && this._center && this._edgeEnd) {
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

  // 중심 + 첫 변 끝 + 두 번째 변 끝으로 4개 꼭짓점 계산
  // 중심에서 edgeEnd까지의 벡터 v1, 중심에서 p3까지의 벡터 v2
  // 꼭짓점: center+v1+v2, center+v1-v2, center-v1-v2, center-v1+v2
  private _computeCorners(
    center: { x: number; y: number },
    edgeEnd: { x: number; y: number },
    p3: { x: number; y: number },
  ): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | null {
    const v1x = edgeEnd.x - center.x;
    const v1y = edgeEnd.y - center.y;
    const v2x = p3.x - center.x;
    const v2y = p3.y - center.y;
    if (Math.hypot(v2x, v2y) < 0.1) return null;

    return [
      { x: center.x + v1x + v2x, y: center.y + v1y + v2y },
      { x: center.x - v1x + v2x, y: center.y - v1y + v2y },
      { x: center.x - v1x - v2x, y: center.y - v1y - v2y },
      { x: center.x + v1x - v2x, y: center.y + v1y - v2y },
    ];
  }

  private _reset(): void {
    this._center = null;
    this._edgeEnd = null;
    this._step = 0;
    this._clearSnaps();
    this.preview = null;
    this.previews = [];
  }
}
