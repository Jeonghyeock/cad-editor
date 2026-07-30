// 원호형 슬롯 (Cylindrical Elongated Hole) 그리기 도구 — CATIA 동작
// 4클릭: 호 중심 → 호 시작점(반지름+시작각) → 호 끝점(sweep) → 폭
// 결과: 바깥 호 + 안쪽 호 + 양 끝 반원 2개 = 트랙 형태
// 총 4 arc + 4 coincident + 4 tangent

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type CylSlotState = "idle" | "start-point" | "end-point" | "width";

export class CylindricalElongatedHoleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "cylindrical-elongated-hole";

  private _state: CylSlotState = "idle";
  private _center: { x: number; y: number } | null = null;
  private _startAngle = 0;
  private _centerR = 0;
  private _endAngle = 0;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      this._recordSnap(store);
      this._center = { ...snappedPos };
      this._state = "start-point";
    } else if (this._state === "start-point") {
      if (!this._center) return;
      const r = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (r < 0.1) return;
      this._recordSnap(store);
      this._centerR = r;
      this._startAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      this._state = "end-point";
    } else if (this._state === "end-point") {
      if (!this._center) return;
      this._endAngle = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      // sweep이 너무 작으면 무시
      let sweep = this._endAngle - this._startAngle;
      if (sweep < 0) sweep += Math.PI * 2;
      if (sweep < 0.05) return;
      this._recordSnap(store);
      this._state = "width";
    } else if (this._state === "width") {
      if (!this._center) return;
      // width 점은 외부 vertex 매칭 안 함 — _recordSnap 생략
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

    if (this._state === "start-point" && this._center) {
      this.preview = {
        type: "line", id: "__preview__",
        x1: this._center.x, y1: this._center.y,
        x2: snappedPos.x, y2: snappedPos.y,
        isConstruction: true,
      };
      this.previews = [];
    } else if (this._state === "end-point" && this._center) {
      // 중심선 호 프리뷰
      const endA = Math.atan2(snappedPos.y - this._center.y, snappedPos.x - this._center.x);
      this.preview = {
        type: "arc", id: "__preview__",
        cx: this._center.x, cy: this._center.y, r: this._centerR,
        startAngle: this._startAngle, endAngle: endA,
      };
      this.previews = [];
    } else if (this._state === "width" && this._center) {
      this.previews = this._buildPreviews(this._center, this._startAngle, this._endAngle, this._centerR, snappedPos);
      this.preview = null;
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {}

  hasPendingWork(): boolean {
    return this._state !== "idle";
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    // R: 중심선 반지름 (start-point 단계), A: 시작각/끝각
    let r: number | undefined;
    let a: number | undefined;
    if (this._state === "start-point" && this._center && mousePos) {
      r = Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y);
      a = Math.atan2(mousePos.y - this._center.y, mousePos.x - this._center.x) * 180 / Math.PI;
    } else if (this._state === "end-point" && this._center && mousePos) {
      r = this._centerR;
      a = Math.atan2(mousePos.y - this._center.y, mousePos.x - this._center.x) * 180 / Math.PI;
    } else if (this._state === "width" && this._center && mousePos) {
      r = this._centerR;
      a = this._endAngle * 180 / Math.PI;
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
    if (this._state === "idle") {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "start-point" && this._center) {
      // R+A: 반지름과 시작각도
      if (values.R !== undefined && values.A !== undefined) {
        const rad = values.A * Math.PI / 180;
        this.onPointerDown(store, {
          x: this._center.x + values.R * Math.cos(rad),
          y: this._center.y + values.R * Math.sin(rad),
        }, {
          x: this._center.x + values.R * Math.cos(rad),
          y: this._center.y + values.R * Math.sin(rad),
        });
        return true;
      }
      if (values.R !== undefined) {
        this.onPointerDown(store, {
          x: this._center.x + values.R,
          y: this._center.y,
        }, {
          x: this._center.x + values.R,
          y: this._center.y,
        });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "end-point" && this._center) {
      // A: 끝각도
      if (values.A !== undefined) {
        const rad = values.A * Math.PI / 180;
        this.onPointerDown(store, {
          x: this._center.x + this._centerR * Math.cos(rad),
          y: this._center.y + this._centerR * Math.sin(rad),
        }, {
          x: this._center.x + this._centerR * Math.cos(rad),
          y: this._center.y + this._centerR * Math.sin(rad),
        });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "width" && this._center) {
      // H/V: 폭 결정점
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
    this._center = null;
    this._startAngle = 0;
    this._centerR = 0;
    this._endAngle = 0;
    this._clearSnaps();
  }

  // --- 폭 계산 ---

  private _computeHalfWidth(center: { x: number; y: number }, centerR: number, mousePos: { x: number; y: number }): number {
    const mouseDist = Math.hypot(mousePos.x - center.x, mousePos.y - center.y);
    return Math.abs(mouseDist - centerR);
  }

  // --- 기하 계산 ---

  private _computeGeoms(
    center: { x: number; y: number },
    startAngle: number,
    endAngle: number,
    centerR: number,
    halfWidth: number,
    isPreview: boolean,
  ): { geoms: SerializedGeometry[]; ids: string[] } | null {
    if (halfWidth < 0.1) return null;
    const outerR = centerR + halfWidth;
    const innerR = centerR - halfWidth;
    if (innerR < 0.1) return null;

    // 반원 중심 (중심선 호의 양 끝점)
    const cap1Cx = center.x + centerR * Math.cos(startAngle);
    const cap1Cy = center.y + centerR * Math.sin(startAngle);
    const cap2Cx = center.x + centerR * Math.cos(endAngle);
    const cap2Cy = center.y + centerR * Math.sin(endAngle);

    // 시작쪽 반원(cap1): inner접점 → 바깥(startAngle 방향) → outer접점
    // inner접점 방향 = startAngle+PI, outer접점 방향 = startAngle
    // CCW: startAngle+PI → startAngle+2PI (sweep=PI, 바깥 경유)
    const cap1Start = startAngle + Math.PI;
    const cap1End = startAngle + 2 * Math.PI;

    // 끝쪽 반원(cap2): outer접점 → 바깥(endAngle 방향) → inner접점
    // outer접점 방향 = endAngle, inner접점 방향 = endAngle+PI
    // CCW: endAngle → endAngle+PI (sweep=PI, 바깥 경유)
    const cap2Start = endAngle;
    const cap2End = endAngle + Math.PI;

    const ids = isPreview
      ? ["__cyl_outer__", "__cyl_inner__", "__cyl_cap1__", "__cyl_cap2__"]
      : [this._generateId(), this._generateId(), this._generateId(), this._generateId()];

    const geoms: SerializedGeometry[] = [
      { type: "arc", id: ids[0], cx: center.x, cy: center.y, r: outerR, startAngle, endAngle },
      { type: "arc", id: ids[1], cx: center.x, cy: center.y, r: innerR, startAngle, endAngle },
      { type: "arc", id: ids[2], cx: cap1Cx, cy: cap1Cy, r: halfWidth, startAngle: cap1Start, endAngle: cap1End },
      { type: "arc", id: ids[3], cx: cap2Cx, cy: cap2Cy, r: halfWidth, startAngle: cap2Start, endAngle: cap2End },
    ];

    return { geoms, ids };
  }

  private _buildPreviews(
    center: { x: number; y: number },
    startAngle: number,
    endAngle: number,
    centerR: number,
    mousePos: { x: number; y: number },
  ): SerializedGeometry[] {
    const hw = this._computeHalfWidth(center, centerR, mousePos);
    const result = this._computeGeoms(center, startAngle, endAngle, centerR, hw, true);
    return result ? result.geoms : [];
  }

  private _finalize(store: SketchGeometryStore, mousePos: { x: number; y: number }): void {
    if (!this._center) return;
    const hw = this._computeHalfWidth(this._center, this._centerR, mousePos);
    const result = this._computeGeoms(this._center, this._startAngle, this._endAngle, this._centerR, hw, false);
    if (!result) { this.cancel(); return; }

    const [outerId, innerId, cap1Id, cap2Id] = result.ids;

    let cIdx = 0;
    const cid = () => `cst_cylslot_${outerId}_${cIdx++}`;
    const constraints = [
      // cap1: v1=inner접점, v2=outer접점. cap2: v1=outer접점, v2=inner접점
      // inner.start(v1) ≡ cap1.start(v1)
      { type: "coincident" as const, id: cid(), pointA: { geomId: innerId, vertexIndex: 1 }, pointB: { geomId: cap1Id, vertexIndex: 1 } },
      // cap1.end(v2) ≡ outer.start(v1)
      { type: "coincident" as const, id: cid(), pointA: { geomId: cap1Id, vertexIndex: 2 }, pointB: { geomId: outerId, vertexIndex: 1 } },
      // outer.end(v2) ≡ cap2.start(v1)
      { type: "coincident" as const, id: cid(), pointA: { geomId: outerId, vertexIndex: 2 }, pointB: { geomId: cap2Id, vertexIndex: 1 } },
      // cap2.end(v2) ≡ inner.end(v2)
      { type: "coincident" as const, id: cid(), pointA: { geomId: cap2Id, vertexIndex: 2 }, pointB: { geomId: innerId, vertexIndex: 2 } },
      // tangent
      { type: "tangent" as const, id: cid(), entityA: { geomId: outerId }, entityB: { geomId: cap1Id } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: cap1Id }, entityB: { geomId: innerId } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: innerId }, entityB: { geomId: cap2Id } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: cap2Id }, entityB: { geomId: outerId } },
    ];

    const finalGeoms = this.constructionMode
      ? result.geoms.map((g) => ({ ...g, isConstruction: true }))
      : result.geoms;

    // Snap 기반 auto-constraint — center / start / end 점을 outer/inner arc 의 center/start/end 와 매핑.
    // click 0 = arc center → outer.center (vertex 0)
    // click 1 = arc start point → outer.start (vertex 1)
    // click 2 = arc end point → outer.end (vertex 2)
    const autoCmds = this._buildSnapConstraints(store, [
      { clickIndex: 0, geomId: outerId, vertexIndex: 0 },
      { clickIndex: 1, geomId: outerId, vertexIndex: 1 },
      { clickIndex: 2, geomId: outerId, vertexIndex: 2 },
    ]);

    const mainCmd = new AddRectangleCommand(finalGeoms, constraints);
    if (autoCmds.length > 0) {
      store.execute(new BatchCommand([mainCmd, ...autoCmds]));
    } else {
      store.execute(mainCmd);
    }
    this.cancel();
    store.requestRender();
  }
}
