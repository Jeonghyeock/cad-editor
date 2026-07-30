// 평행사변형 그리기 도구: 3클릭 — 첫 변 시작점 → 끝점 → 높이(임의 방향)
// OrientedRectangle과 유사하지만 두 번째 변이 첫 번째와 평행이 아닌 임의 방향
// 4 line + 4 coincident 구속으로 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class ParallelogramDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "parallelogram";

  private _p1: { x: number; y: number } | null = null; // 첫 변 시작점
  private _p2: { x: number; y: number } | null = null; // 첫 변 끝점
  private _step: 0 | 1 | 2 = 0; // 0: 시작점 대기, 1: 끝점 대기, 2: 높이 대기
  // CATIA SmartPick — 첫 변 / 두 번째 변 각각의 directional inference 결과 저장
  private _pendingDirInferenceEdge0: { sourceGeomId: string; relation: "parallel" | "perpendicular" | "colinear" } | null = null;
  private _pendingDirInferenceEdge1: { sourceGeomId: string; relation: "parallel" | "perpendicular" | "colinear" } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._step === 0) {
      // 첫 클릭: 첫 변 시작점
      this._recordSnap(store);
      this._p1 = { ...snappedPos };
      this._step = 1;
    } else if (this._step === 1 && this._p1) {
      // 두 번째 클릭: 첫 변 끝점. P3.4 — 첫 변 방향 추론.
      const len = Math.hypot(snappedPos.x - this._p1.x, snappedPos.y - this._p1.y);
      if (len < 0.1) return;
      this._recordSnap(store);
      let endPos = { ...snappedPos };
      const dir0 = this._applyParallelPerpendicularSnap(store, this._p1, endPos);
      if (dir0) {
        endPos = dir0.pos;
        this._pendingDirInferenceEdge0 = { sourceGeomId: dir0.sourceGeomId, relation: dir0.relation };
      }
      this._p2 = endPos;
      this._step = 2;
    } else if (this._step === 2 && this._p1 && this._p2) {
      // 세 번째 클릭: 높이 확정 → 평행사변형 생성.
      // P3.4 — 두 번째 변 (line[1]: p2 → p3) 의 방향 추론도 함께.
      this._recordSnap(store);
      let thirdPos = { ...snappedPos };
      const dir1 = this._applyParallelPerpendicularSnap(store, this._p2, thirdPos);
      if (dir1) {
        thirdPos = dir1.pos;
        this._pendingDirInferenceEdge1 = { sourceGeomId: dir1.sourceGeomId, relation: dir1.relation };
      }
      const corners = this._computeCorners(this._p1, this._p2, thirdPos);
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

      // Coincident: line[i].end ≡ line[(i+1)%4].start
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

      // 스냅 기반 auto-constraint: click 0→c0=line[0].v0, click 1→c1=line[0].v1, click 2→c2=line[1].v1
      const autoCmds = this._buildSnapConstraints(store, [
        { clickIndex: 0, geomId: lineIds[0], vertexIndex: 0 },
        { clickIndex: 1, geomId: lineIds[0], vertexIndex: 1 },
        { clickIndex: 2, geomId: lineIds[1], vertexIndex: 1 },
      ]);

      // P3.4 — line[0] / line[1] 의 directional constraint 자동 부여
      if (this.autoGeoConstraints) {
        if (this._pendingDirInferenceEdge0) {
          autoCmds.push(new AddConstraintCommand({
            type: this._pendingDirInferenceEdge0.relation,
            id: generateConstraintId("auto-cst"),
            lineA: { geomId: lineIds[0] },
            lineB: { geomId: this._pendingDirInferenceEdge0.sourceGeomId },
          }));
        }
        if (this._pendingDirInferenceEdge1) {
          autoCmds.push(new AddConstraintCommand({
            type: this._pendingDirInferenceEdge1.relation,
            id: generateConstraintId("auto-cst"),
            lineA: { geomId: lineIds[1] },
            lineB: { geomId: this._pendingDirInferenceEdge1.sourceGeomId },
          }));
        }
      }

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
    // 기하 기반 추론선
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (this._step === 1 && this._p1) {
      // 첫 변 프리뷰
      this.previews = [
        { type: "line", id: "__preview_0__", x1: this._p1.x, y1: this._p1.y, x2: snappedPos.x, y2: snappedPos.y },
      ];
    } else if (this._step === 2 && this._p1 && this._p2) {
      // 전체 평행사변형 프리뷰
      const corners = this._computeCorners(this._p1, this._p2, snappedPos);
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
    // 클릭 방식이므로 pointerUp에서는 처리 없음
  }

  hasPendingWork(): boolean {
    return this._step > 0;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    // H, V: 현재 마우스, L: 첫 변 길이, A: 첫 변 각도
    const l = this._p1 && mousePos && this._step === 1
      ? Math.hypot(mousePos.x - this._p1.x, mousePos.y - this._p1.y)
      : this._p1 && this._p2
        ? Math.hypot(this._p2.x - this._p1.x, this._p2.y - this._p1.y)
        : undefined;
    const a = this._p1 && mousePos && this._step === 1
      ? Math.atan2(mousePos.y - this._p1.y, mousePos.x - this._p1.x) * 180 / Math.PI
      : this._p1 && this._p2
        ? Math.atan2(this._p2.y - this._p1.y, this._p2.x - this._p1.x) * 180 / Math.PI
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
    if (this._step === 1 && this._p1) {
      // L+A: 첫 변 끝점을 극좌표로
      if (values.L !== undefined && values.A !== undefined) {
        const rad = values.A * Math.PI / 180;
        this.onPointerDown(store, {
          x: this._p1.x + values.L * Math.cos(rad),
          y: this._p1.y + values.L * Math.sin(rad),
        }, {
          x: this._p1.x + values.L * Math.cos(rad),
          y: this._p1.y + values.L * Math.sin(rad),
        });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._step === 2 && this._p1 && this._p2) {
      // H/V: 세 번째 꼭짓점 직접 지정
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

  // 3점으로부터 4개 꼭짓점 계산 (평행사변형)
  // p1→p2: 첫 변, p3: 두 번째 꼭짓점 방향 (p2에서 p3로의 오프셋을 p1에도 적용)
  private _computeCorners(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | null {
    // p3는 p2에서의 오프셋 방향을 결정
    const ox = p3.x - p2.x;
    const oy = p3.y - p2.y;
    if (Math.hypot(ox, oy) < 0.1) return null;

    // c0=p1, c1=p2, c2=p2+offset, c3=p1+offset
    return [
      { x: p1.x, y: p1.y },
      { x: p2.x, y: p2.y },
      { x: p2.x + ox, y: p2.y + oy },
      { x: p1.x + ox, y: p1.y + oy },
    ];
  }

  private _reset(): void {
    this._p1 = null;
    this._p2 = null;
    this._step = 0;
    this._pendingDirInferenceEdge0 = null;
    this._pendingDirInferenceEdge1 = null;
    this._clearSnaps();
    this.preview = null;
    this.previews = [];
  }
}
