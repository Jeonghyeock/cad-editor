// 라운드 사각형(Oblong) 그리기 도구: 3클릭 — 중심 → 축 끝점 (길이+방향) → 폭
// 결과: 2 line + 2 arc (둥근 끝) + 4 coincident + 2 tangent + 2 equal (arc 반지름 동일)
// BatchCommand로 원자적 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type OblongState = "idle" | "axis-end" | "width";

export class OblongDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "oblong";

  private _state: OblongState = "idle";
  private _center: { x: number; y: number } | null = null;
  private _axisEnd: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      // 첫 클릭: 중심점
      this._recordSnap(store);
      this._center = { ...snappedPos };
      this._state = "axis-end";
    } else if (this._state === "axis-end") {
      // 두 번째 클릭: 축 끝점 (길이 + 방향 결정)
      if (!this._center) return;
      const dist = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (dist < 0.1) return;
      this._recordSnap(store);
      this._axisEnd = { ...snappedPos };
      this._state = "width";
    } else if (this._state === "width") {
      // 세 번째 클릭: 폭 확정
      if (!this._center || !this._axisEnd) return;
      this._recordSnap(store);
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

    if (this._state === "axis-end" && this._center) {
      // 중심→축 끝점 프리뷰 (construction line)
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
    } else if (this._state === "width" && this._center && this._axisEnd) {
      // oblong 프리뷰
      const w = this._computeWidth(snappedPos);
      this.previews = this._buildPreviews(this._center, this._axisEnd, w);
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
    const l = this._center && mousePos && this._state === "axis-end"
      ? Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y)
      : this._center && this._axisEnd
        ? Math.hypot(this._axisEnd.x - this._center.x, this._axisEnd.y - this._center.y)
        : undefined;
    const w = this._state === "width" && mousePos
      ? this._computeWidth(mousePos)
      : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: l },
      { type: "W", label: "W", value: w },
    ];
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._center = null;
    this._axisEnd = null;
  }

  // --- 내부 ---

  // 마우스 위치에서 축 방향과 수직인 거리를 폭으로 계산
  private _computeWidth(mousePos: { x: number; y: number }): number {
    if (!this._center || !this._axisEnd) return 0;
    const dx = this._axisEnd.x - this._center.x;
    const dy = this._axisEnd.y - this._center.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return 0;
    // 축 방향 법선으로 투영한 거리
    const nx = -dy / len;
    const ny = dx / len;
    return Math.abs((mousePos.x - this._center.x) * nx + (mousePos.y - this._center.y) * ny);
  }

  // oblong 기하 프리뷰 생성
  private _buildPreviews(
    center: { x: number; y: number },
    axisEnd: { x: number; y: number },
    halfWidth: number,
  ): SerializedGeometry[] {
    if (halfWidth < 0.1) return [];
    const { lines, arcs } = this._computeGeometries(center, axisEnd, halfWidth, true);
    return [...lines, ...arcs];
  }

  // oblong 기하 데이터 계산
  // center에서 axisEnd까지가 반축 길이. 반대쪽도 대칭으로 확장
  private _computeGeometries(
    center: { x: number; y: number },
    axisEnd: { x: number; y: number },
    halfWidth: number,
    isPreview: boolean,
  ): { lines: SerializedGeometry[]; arcs: SerializedGeometry[]; lineIds: string[]; arcIds: string[] } {
    const dx = axisEnd.x - center.x;
    const dy = axisEnd.y - center.y;
    const halfLen = Math.hypot(dx, dy);
    if (halfLen < 1e-9) return { lines: [], arcs: [], lineIds: [], arcIds: [] };

    // 축 방향 단위 벡터
    const ux = dx / halfLen;
    const uy = dy / halfLen;
    // 법선 방향
    const nx = -uy;
    const ny = ux;

    // 축 양 끝점 (중심에서 대칭)
    const endA = { x: center.x + ux * halfLen, y: center.y + uy * halfLen };
    const endB = { x: center.x - ux * halfLen, y: center.y - uy * halfLen };

    // 4개 꼭짓점
    const p1 = { x: endA.x + nx * halfWidth, y: endA.y + ny * halfWidth };
    const p2 = { x: endA.x - nx * halfWidth, y: endA.y - ny * halfWidth };
    const p3 = { x: endB.x - nx * halfWidth, y: endB.y - ny * halfWidth };
    const p4 = { x: endB.x + nx * halfWidth, y: endB.y + ny * halfWidth };

    const angle = Math.atan2(dy, dx);

    // endA 쪽 반원: p1 → (바깥) → p2 (CCW)
    const arcAStart = angle + Math.PI / 2;   // p1 방향
    const arcAEnd = angle - Math.PI / 2;     // p2 방향 (CCW로 바깥쪽)

    // endB 쪽 반원: p3 → (바깥) → p4 (CCW)
    const arcBStart = angle - Math.PI / 2;           // p3 방향
    const arcBEnd = angle - Math.PI / 2 + Math.PI;   // p4 방향

    const lineId1 = isPreview ? "__oblong_line1__" : this._generateId();
    const lineId2 = isPreview ? "__oblong_line2__" : this._generateId();
    const arcId1 = isPreview ? "__oblong_arc1__" : this._generateId();
    const arcId2 = isPreview ? "__oblong_arc2__" : this._generateId();

    const lines: SerializedGeometry[] = [
      { type: "line", id: lineId1, x1: p1.x, y1: p1.y, x2: p4.x, y2: p4.y },
      { type: "line", id: lineId2, x1: p2.x, y1: p2.y, x2: p3.x, y2: p3.y },
    ];

    const arcs: SerializedGeometry[] = [
      { type: "arc", id: arcId1, cx: endA.x, cy: endA.y, r: halfWidth, startAngle: arcAEnd, endAngle: arcAStart },
      { type: "arc", id: arcId2, cx: endB.x, cy: endB.y, r: halfWidth, startAngle: arcBStart, endAngle: arcBEnd },
    ];

    return { lines, arcs, lineIds: [lineId1, lineId2], arcIds: [arcId1, arcId2] };
  }

  private _finalize(
    store: SketchGeometryStore,
    mousePos: { x: number; y: number },
  ): void {
    if (!this._center || !this._axisEnd) return;

    const halfWidth = this._computeWidth(mousePos);
    if (halfWidth < 0.1) {
      this.cancel();
      return;
    }

    const { lines, arcs, lineIds, arcIds } = this._computeGeometries(
      this._center, this._axisEnd, halfWidth, false,
    );
    if (lines.length === 0) {
      this.cancel();
      return;
    }

    const allGeometries = [...lines, ...arcs];

    // 구속조건 생성
    // arc vertex: 0=center, 1=start, 2=end
    // line vertex: 0=start, 1=end
    // line1: p1(v0) → p4(v1), line2: p2(v0) → p3(v1)
    // arc1(endA): start(v1)=arcAEnd방향=p2, end(v2)=arcAStart방향=p1
    // arc2(endB): start(v1)=arcBStart방향=p3, end(v2)=arcBEnd방향=p4
    let cIdx = 0;
    const cid = () => `cst_oblong_${lineIds[0]}_${cIdx++}`;
    const constraints = [
      // 4 coincident: 순환 연결
      // arc1.end(2)=p1 ≡ line1.start(0)=p1
      { type: "coincident" as const, id: cid(), pointA: { geomId: arcIds[0], vertexIndex: 2 }, pointB: { geomId: lineIds[0], vertexIndex: 0 } },
      // line1.end(1)=p4 ≡ arc2.end(2)=p4
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[0], vertexIndex: 1 }, pointB: { geomId: arcIds[1], vertexIndex: 2 } },
      // arc2.start(1)=p3 ≡ line2.end(1)=p3
      { type: "coincident" as const, id: cid(), pointA: { geomId: arcIds[1], vertexIndex: 1 }, pointB: { geomId: lineIds[1], vertexIndex: 1 } },
      // line2.start(0)=p2 ≡ arc1.start(1)=p2
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineIds[1], vertexIndex: 0 }, pointB: { geomId: arcIds[0], vertexIndex: 1 } },
      // 2 tangent: line↔arc 접합
      { type: "tangent" as const, id: cid(), entityA: { geomId: lineIds[0] }, entityB: { geomId: arcIds[0] } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: lineIds[0] }, entityB: { geomId: arcIds[1] } },
      // 2 equal_radius: arc 반지름 동일
      { type: "equal_radius" as const, id: cid(), circleA: { geomId: arcIds[0] }, circleB: { geomId: arcIds[1] } },
    ];

    const finalGeometries = this.constructionMode
      ? allGeometries.map((g) => ({ ...g, isConstruction: true }))
      : allGeometries;
    store.execute(new AddRectangleCommand(finalGeometries, constraints));
    this.cancel();
    store.requestRender();
  }
}
