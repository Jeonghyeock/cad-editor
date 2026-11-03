// 기울어진 사각형 그리기 도구: 3클릭 — 첫 변 시작점 → 끝점 → 높이(수직 방향)
// 첫 변 방향이 사각형의 각도를 결정, 4개 line + 4개 coincident 구속으로 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class OrientedRectangleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "oriented-rectangle";

  private _p1: { x: number; y: number } | null = null; // 첫 변 시작점
  private _p2: { x: number; y: number } | null = null; // 첫 변 끝점
  private _step: 0 | 1 | 2 = 0; // 0: 시작점 대기, 1: 끝점 대기, 2: 높이 대기
  // CATIA SmartPick: 첫 변이 기존 line/axis 와 평행/수직/공선 추론 결과 저장
  private _pendingDirInference: { sourceGeomId: string; relation: "parallel" | "perpendicular" | "colinear" } | null = null;

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
      // 두 번째 클릭: 첫 변 끝점. P3.4 — 기존 line/axis 와 평행/수직/공선 자동 추론.
      const len = Math.hypot(snappedPos.x - this._p1.x, snappedPos.y - this._p1.y);
      if (len < 0.1) return; // 너무 짧으면 무시
      this._recordSnap(store);
      let endPos = { ...snappedPos };
      const dir = this._applyParallelPerpendicularSnap(store, this._p1, endPos);
      if (dir) {
        endPos = dir.pos;
        this._pendingDirInference = { sourceGeomId: dir.sourceGeomId, relation: dir.relation };
      }
      this._p2 = endPos;
      this._step = 2;
    } else if (this._step === 2 && this._p1 && this._p2) {
      // 세 번째 클릭: 높이 확정 → 사각형 생성 (click 2 스냅은 vertex에 매핑되지 않음)
      const corners = this._computeCorners(this._p1, this._p2, snappedPos);
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

      // Coincident: line[i].end ≡ line[(i+1)%4].start (H/V 구속 없음)
      const constraints = [
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[0], vertexIndex: 1 }, pointB: { geomId: lineIds[1], vertexIndex: 0 } },
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[1], vertexIndex: 1 }, pointB: { geomId: lineIds[2], vertexIndex: 0 } },
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[2], vertexIndex: 1 }, pointB: { geomId: lineIds[3], vertexIndex: 0 } },
        { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[3], vertexIndex: 1 }, pointB: { geomId: lineIds[0], vertexIndex: 0 } },
        // Parallel: 대변 평행
        { type: "parallel" as const, id: cid(), lineA: { geomId: lineIds[0] }, lineB: { geomId: lineIds[2] } },
        { type: "parallel" as const, id: cid(), lineA: { geomId: lineIds[1] }, lineB: { geomId: lineIds[3] } },
        // Perpendicular: 인접변 직각
        { type: "perpendicular" as const, id: cid(), lineA: { geomId: lineIds[0] }, lineB: { geomId: lineIds[1] } },
      ];

      const finalGeometries = this.constructionMode
        ? geometries.map((g) => ({ ...g, isConstruction: true }))
        : geometries;

      // 스냅 기반 auto-constraint: click 0 → c0=line[0].v0, click 1 → c1=line[0].v1
      const autoCmds = this._buildSnapConstraints(store, [
        { clickIndex: 0, geomId: lineIds[0], vertexIndex: 0 },
        { clickIndex: 1, geomId: lineIds[0], vertexIndex: 1 },
      ]);

      // P3.4 — line[0] 의 parallel/perpendicular/colinear 자동 부여 (첫 변 방향 추론 결과).
      if (this._pendingDirInference && this.autoGeoConstraints) {
        autoCmds.push(new AddConstraintCommand({
          type: this._pendingDirInference.relation,
          id: generateConstraintId("auto-cst"),
          lineA: { geomId: lineIds[0] },
          lineB: { geomId: this._pendingDirInference.sourceGeomId },
        }));
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
      // 첫 변 프리뷰 — 확정(onPointerDown)과 같은 평행·수직·공선 보정을 거친 끝점
      const end = this._applyParallelPerpendicularSnap(store, this._p1, snappedPos)?.pos ?? snappedPos;
      this.previews = [
        { type: "line", id: "__preview_0__", x1: this._p1.x, y1: this._p1.y, x2: end.x, y2: end.y },
      ];
    } else if (this._step === 2 && this._p1 && this._p2) {
      // 전체 사각형 프리뷰
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
    // L: 첫 변 길이 (step >= 1), A: 첫 변 각도 (step >= 1), W: 높이 (step >= 2)
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
    let w: number | undefined;
    if (this._step === 2 && this._p1 && this._p2 && mousePos) {
      const dx = this._p2.x - this._p1.x;
      const dy = this._p2.y - this._p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-9) {
        const nx = -dy / len;
        const ny = dx / len;
        const vx = mousePos.x - this._p1.x;
        const vy = mousePos.y - this._p1.y;
        w = Math.abs(vx * nx + vy * ny);
      }
    }
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: l },
      { type: "A", label: "A", value: a },
      { type: "W", label: "W", value: w },
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
      // W: 높이 입력
      if (values.W !== undefined) {
        const dx = this._p2.x - this._p1.x;
        const dy = this._p2.y - this._p1.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-9) {
          const nx = -dy / len;
          const ny = dx / len;
          this.onPointerDown(store, {
            x: this._p1.x + nx * values.W,
            y: this._p1.y + ny * values.W,
          }, {
            x: this._p1.x + nx * values.W,
            y: this._p1.y + ny * values.W,
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
    this._reset();
  }

  // 3점으로부터 4개 꼭짓점 계산
  // p1→p2: 첫 변, p3: 높이 방향 결정
  private _computeCorners(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | null {
    // 첫 변 방향 벡터
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;

    // 수직 단위 벡터 (첫 변에 직교)
    const nx = -dy / len;
    const ny = dx / len;

    // p3를 수직 방향으로 투영하여 높이 계산
    const vx = p3.x - p1.x;
    const vy = p3.y - p1.y;
    const height = vx * nx + vy * ny;
    if (Math.abs(height) < 0.1) return null;

    // 4개 꼭짓점: p1 → p2 → p2+offset → p1+offset
    const ox = nx * height;
    const oy = ny * height;

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
    this._pendingDirInference = null;
    this._clearSnaps();
    this.preview = null;
    this.previews = [];
  }
}
