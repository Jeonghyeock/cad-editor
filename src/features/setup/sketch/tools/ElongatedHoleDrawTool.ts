// Elongated Hole (슬롯) 그리기 도구: 3클릭 — 중심선 시작점 → 중심선 끝점 → 폭(반지름)
// 결과: 2 line (양쪽 평행선) + 2 arc (양끝 반원) + 4 coincident
// BatchCommand로 원자적 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type SlotState = "idle" | "center-end" | "width";

export class ElongatedHoleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "elongated-hole";

  private _state: SlotState = "idle";
  private _centerStart: { x: number; y: number } | null = null;
  private _centerEnd: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      // 첫 클릭: 중심선 시작점
      this._recordSnap(store);
      this._centerStart = { ...snappedPos };
      this._state = "center-end";
    } else if (this._state === "center-end") {
      // 두 번째 클릭: 중심선 끝점
      if (!this._centerStart) return;
      const dist = Math.hypot(snappedPos.x - this._centerStart.x, snappedPos.y - this._centerStart.y);
      if (dist < 0.1) return;
      this._recordSnap(store);
      this._centerEnd = { ...snappedPos };
      this._state = "width";
    } else if (this._state === "width") {
      // 세 번째 클릭: 폭 확정 (width 점은 외부 vertex 매칭 안 함 — _recordSnap 생략)
      if (!this._centerStart || !this._centerEnd) return;
      this._finalize(store, snappedPos);
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 추론선
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (this._state === "center-end" && this._centerStart) {
      // 중심선 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._centerStart.x,
        y1: this._centerStart.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isConstruction: true,
      };
      this.previews = [];
    } else if (this._state === "width" && this._centerStart && this._centerEnd) {
      // 슬롯 프리뷰
      const r = this._computeWidth(this._centerStart, this._centerEnd, snappedPos);
      this.previews = this._buildSlotPreviews(this._centerStart, this._centerEnd, r);
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
    // L: 중심선 길이 (center-end 이후), R: 폭 반지름 (width 단계)
    const l = this._centerStart && mousePos && this._state === "center-end"
      ? Math.hypot(mousePos.x - this._centerStart.x, mousePos.y - this._centerStart.y)
      : this._centerStart && this._centerEnd
        ? Math.hypot(this._centerEnd.x - this._centerStart.x, this._centerEnd.y - this._centerStart.y)
        : undefined;
    const r = this._state === "width" && this._centerEnd && mousePos
      ? Math.hypot(mousePos.x - this._centerEnd.x, mousePos.y - this._centerEnd.y)
      : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: l },
      { type: "R", label: "R", value: r },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (this._state === "idle") {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "center-end" && this._centerStart) {
      // L: 중심선 길이를 수평 방향으로 (또는 H/V)
      if (values.L !== undefined) {
        this.onPointerDown(store, {
          x: this._centerStart.x + values.L,
          y: this._centerStart.y,
        }, {
          x: this._centerStart.x + values.L,
          y: this._centerStart.y,
        });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "width" && this._centerEnd) {
      // R: 폭 반지름
      if (values.R !== undefined) {
        this.onPointerDown(store, {
          x: this._centerEnd.x + values.R,
          y: this._centerEnd.y,
        }, {
          x: this._centerEnd.x + values.R,
          y: this._centerEnd.y,
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
    this._state = "idle";
    this._centerStart = null;
    this._centerEnd = null;
    this._clearSnaps();
  }

  // --- 내부 ---

  // 둘째 점(centerEnd)에서 마우스까지의 거리를 반지름으로 사용
  private _computeWidth(
    _start: { x: number; y: number },
    end: { x: number; y: number },
    mousePos: { x: number; y: number },
  ): number {
    return Math.hypot(mousePos.x - end.x, mousePos.y - end.y);
  }

  // 슬롯 기하 프리뷰 생성
  private _buildSlotPreviews(
    start: { x: number; y: number },
    end: { x: number; y: number },
    r: number,
  ): SerializedGeometry[] {
    if (r < 0.1) return [];
    const { lines, arcs } = this._computeSlotGeometries(start, end, r, true);
    return [...lines, ...arcs];
  }

  // 슬롯 기하 데이터 계산
  private _computeSlotGeometries(
    start: { x: number; y: number },
    end: { x: number; y: number },
    r: number,
    isPreview: boolean,
  ): { lines: SerializedGeometry[]; arcs: SerializedGeometry[]; lineIds: string[]; arcIds: string[] } {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { lines: [], arcs: [], lineIds: [], arcIds: [] };

    // 법선 방향
    const nx = -dy / len;
    const ny = dx / len;

    // 4개 꼭짓점 (평행선 끝점)
    const p1 = { x: start.x + nx * r, y: start.y + ny * r }; // start + normal
    const p2 = { x: end.x + nx * r, y: end.y + ny * r };     // end + normal
    const p3 = { x: end.x - nx * r, y: end.y - ny * r };     // end - normal
    const p4 = { x: start.x - nx * r, y: start.y - ny * r }; // start - normal

    // 중심선 방향 각도
    const angle = Math.atan2(dy, dx);

    // 끝측 반원 (center=end): p2 → 바깥쪽(전진방향) → p3
    // p2는 end+normal 방향(angle+PI/2), p3는 end-normal 방향(angle-PI/2)
    // 바깥쪽 = 전진 방향(angle)을 거쳐 돌아야 함
    // CCW: angle-PI/2 → angle+PI/2 (sweep=PI, 전진 방향 바깥쪽)
    const endArcStart = angle - Math.PI / 2;  // p3 방향에서 시작
    const endArcEnd = angle + Math.PI / 2;    // p2 방향에서 끝

    // 시작측 반원 (center=start): p4 → 바깥쪽(후진방향) → p1
    // p4는 start-normal 방향(angle-PI/2), p1은 start+normal 방향(angle+PI/2)
    // 바깥쪽 = 후진 방향(angle+PI)을 거쳐 돌아야 함
    // CCW: angle+PI/2 → angle+3PI/2 (= angle-PI/2+2PI, sweep=PI, 후진 방향 바깥쪽)
    const startArcStart = angle + Math.PI / 2;      // p1 방향에서 시작
    const startArcEnd = angle + Math.PI / 2 + Math.PI; // p4 방향에서 끝

    const lineId1 = isPreview ? "__slot_line1__" : this._generateId();
    const lineId2 = isPreview ? "__slot_line2__" : this._generateId();
    const arcId1 = isPreview ? "__slot_arc1__" : this._generateId();
    const arcId2 = isPreview ? "__slot_arc2__" : this._generateId();

    const lines: SerializedGeometry[] = [
      { type: "line", id: lineId1, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
      { type: "line", id: lineId2, x1: p3.x, y1: p3.y, x2: p4.x, y2: p4.y },
    ];

    const arcs: SerializedGeometry[] = [
      { type: "arc", id: arcId1, cx: end.x, cy: end.y, r, startAngle: endArcStart, endAngle: endArcEnd },
      { type: "arc", id: arcId2, cx: start.x, cy: start.y, r, startAngle: startArcStart, endAngle: startArcEnd },
    ];

    return { lines, arcs, lineIds: [lineId1, lineId2], arcIds: [arcId1, arcId2] };
  }

  private _finalize(
    store: SketchGeometryStore,
    mousePos: { x: number; y: number },
  ): void {
    if (!this._centerStart || !this._centerEnd) return;

    const r = this._computeWidth(this._centerStart, this._centerEnd, mousePos);
    if (r < 0.1) {
      this.cancel();
      return;
    }

    const { lines, arcs, lineIds, arcIds } = this._computeSlotGeometries(
      this._centerStart, this._centerEnd, r, false,
    );
    if (lines.length === 0) {
      this.cancel();
      return;
    }

    const allGeometries = [...lines, ...arcs];

    // 4개 coincident 구속: 순환 연결 line1→arc1→line2→arc2→line1
    // arc vertex: 0=center, 1=start, 2=end
    // line vertex: 0=start(p1/p3), 1=end(p2/p4)
    // arc1(end): start(v1)=p3, end(v2)=p2
    // arc2(start): start(v1)=p1, end(v2)=p4
    let cIdx = 0;
    const cid = () => `cst_slot_${lineIds[0]}_${cIdx++}`;
    const constraints = [
      // line1.end(1)=p2 ≡ arc1.end(2)=p2
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[0], vertexIndex: 1 }, pointB: { geomId: arcIds[0], vertexIndex: 2 } },
      // arc1.start(1)=p3 ≡ line2.start(0)=p3
      { type: "coincident" as const, id: cid(), pointA: { geomId: arcIds[0], vertexIndex: 1 }, pointB: { geomId: lineIds[1], vertexIndex: 0 } },
      // line2.end(1)=p4 ≡ arc2.end(2)=p4
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[1], vertexIndex: 1 }, pointB: { geomId: arcIds[1], vertexIndex: 2 } },
      // arc2.start(1)=p1 ≡ line1.start(0)=p1
      { type: "coincident" as const, id: cid(), pointA: { geomId: arcIds[1], vertexIndex: 1 }, pointB: { geomId: lineIds[0], vertexIndex: 0 } },
      // 4개 tangent 구속: line↔arc 접합점마다
      { type: "tangent" as const, id: cid(), entityA: { geomId: lineIds[0] }, entityB: { geomId: arcIds[0] } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: arcIds[0] }, entityB: { geomId: lineIds[1] } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: lineIds[1] }, entityB: { geomId: arcIds[1] } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: arcIds[1] }, entityB: { geomId: lineIds[0] } },
    ];

    const finalGeometries = this.constructionMode
      ? allGeometries.map((g) => ({ ...g, isConstruction: true }))
      : allGeometries;

    // Snap 기반 auto-constraint — 중심선 양 끝점이 arc center (vertex 0) 와 매핑.
    // click 0 = centerStart = arc2.center, click 1 = centerEnd = arc1.center.
    const autoCmds = this._buildSnapConstraints(store, [
      { clickIndex: 0, geomId: arcIds[1], vertexIndex: 0 },
      { clickIndex: 1, geomId: arcIds[0], vertexIndex: 0 },
    ]);

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
