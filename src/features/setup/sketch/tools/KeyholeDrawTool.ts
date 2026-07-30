// 키홀 형태 그리기 도구: CATIA 방식 4클릭
// 큰원 중심 → 작은원 중심 → 작은원 반지름 → 큰원 반지름
// 연결 직선 2개는 중심축에 평행 (작은원 접선 높이)
// 결과: 2 arc + 2 line + 4 coincident + 2 tangent + 1 parallel + 2 radius

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type KeyholeState = "idle" | "small-center" | "small-radius" | "big-radius";

export class KeyholeDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "keyhole";

  private _state: KeyholeState = "idle";
  private _bigCenter: { x: number; y: number } | null = null;
  private _smallCenter: { x: number; y: number } | null = null;
  private _smallR: number = 0;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "idle") {
      // 1클릭: 큰원 중심
      this._recordSnap(store);
      this._bigCenter = { ...snappedPos };
      this._state = "small-center";
    } else if (this._state === "small-center") {
      // 2클릭: 작은원 중심
      if (!this._bigCenter) return;
      const dist = Math.hypot(snappedPos.x - this._bigCenter.x, snappedPos.y - this._bigCenter.y);
      if (dist < 0.1) return;
      this._recordSnap(store);
      this._smallCenter = { ...snappedPos };
      this._state = "small-radius";
    } else if (this._state === "small-radius") {
      // 3클릭: 작은원 반지름 (radius 점은 외부 vertex 매칭 안 함)
      if (!this._smallCenter) return;
      const r = Math.hypot(snappedPos.x - this._smallCenter.x, snappedPos.y - this._smallCenter.y);
      if (r < 0.1) return;
      this._smallR = r;
      this._state = "big-radius";
    } else if (this._state === "big-radius") {
      // 4클릭: 큰원 반지름 → 확정
      if (!this._bigCenter || !this._smallCenter) return;
      const bigR = Math.hypot(snappedPos.x - this._bigCenter.x, snappedPos.y - this._bigCenter.y);
      if (bigR < this._smallR + 0.1) return; // 큰원이 작은원보다 커야 함
      this._finalize(store, bigR);
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

    if (this._state === "small-center" && this._bigCenter) {
      // 큰원 중심 → 마우스 연결선 프리뷰
      this.preview = {
        type: "line", id: "__preview__",
        x1: this._bigCenter.x, y1: this._bigCenter.y,
        x2: snappedPos.x, y2: snappedPos.y,
        isConstruction: true,
      };
      this.previews = [];
    } else if (this._state === "small-radius" && this._bigCenter && this._smallCenter) {
      // 작은 반원 + 직선 2개 + 큰 호 프리뷰 (bigR 추정값 사용)
      const r = Math.hypot(snappedPos.x - this._smallCenter.x, snappedPos.y - this._smallCenter.y);
      this.preview = null;
      if (r < 0.1) {
        this.previews = [];
      } else {
        const d = Math.hypot(this._smallCenter.x - this._bigCenter.x, this._smallCenter.y - this._bigCenter.y);
        // bigR 추정: 중심 거리의 절반 (최소 smallR*2)
        const estimatedBigR = Math.max(r * 2, d * 0.5);
        const khResult = this._computeKeyhole(this._bigCenter, this._smallCenter, r, estimatedBigR);
        if (khResult) {
          this.previews = this._buildPreviews(this._bigCenter, this._smallCenter, r, estimatedBigR);
        } else {
          this.previews = [];
        }
      }
    } else if (this._state === "big-radius" && this._bigCenter && this._smallCenter) {
      // 키홀 전체 프리뷰
      const bigR = Math.hypot(snappedPos.x - this._bigCenter.x, snappedPos.y - this._bigCenter.y);
      const effectiveBigR = Math.max(this._smallR + 0.1, bigR);
      this.preview = null;
      this.previews = this._buildPreviews(this._bigCenter, this._smallCenter, this._smallR, effectiveBigR);
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
    // R: small-radius 단계에서는 작은원 반지름, big-radius 단계에서는 큰원 반지름
    let r: number | undefined;
    if (this._state === "small-radius" && this._smallCenter && mousePos) {
      r = Math.hypot(mousePos.x - this._smallCenter.x, mousePos.y - this._smallCenter.y);
    } else if (this._state === "big-radius" && this._bigCenter && mousePos) {
      r = Math.hypot(mousePos.x - this._bigCenter.x, mousePos.y - this._bigCenter.y);
    }
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
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
    if (this._state === "small-center") {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "small-radius" && this._smallCenter) {
      if (values.R !== undefined) {
        this.onPointerDown(store, {
          x: this._smallCenter.x + values.R,
          y: this._smallCenter.y,
        }, {
          x: this._smallCenter.x + values.R,
          y: this._smallCenter.y,
        });
        return true;
      }
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    if (this._state === "big-radius" && this._bigCenter) {
      if (values.R !== undefined) {
        this.onPointerDown(store, {
          x: this._bigCenter.x + values.R,
          y: this._bigCenter.y,
        }, {
          x: this._bigCenter.x + values.R,
          y: this._bigCenter.y,
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
    this._bigCenter = null;
    this._smallCenter = null;
    this._smallR = 0;
    this._clearSnaps();
  }

  // --- 내부 ---

  // 키홀 기하 계산: 직선은 중심축에 평행, 작은원 접선 높이
  private _computeKeyhole(
    bigCenter: { x: number; y: number },
    smallCenter: { x: number; y: number },
    smallR: number,
    bigR: number,
  ): {
    bigArc: { startAngle: number; endAngle: number };
    smallArc: { startAngle: number; endAngle: number };
    line1: { x1: number; y1: number; x2: number; y2: number };
    line2: { x1: number; y1: number; x2: number; y2: number };
  } | null {
    const dx = smallCenter.x - bigCenter.x;
    const dy = smallCenter.y - bigCenter.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.1 || bigR <= smallR) return null;

    // 중심축: big → small 방향
    const axisAngle = Math.atan2(dy, dx);
    const axisDx = Math.cos(axisAngle);
    const axisDy = Math.sin(axisAngle);
    // 법선 (축 기준 +90° CCW)
    const nx = -axisDy;
    const ny = axisDx;

    // 작은원 접점: smallCenter ± normal * smallR
    const sTop = { x: smallCenter.x + nx * smallR, y: smallCenter.y + ny * smallR };
    const sBot = { x: smallCenter.x - nx * smallR, y: smallCenter.y - ny * smallR };

    // 큰원 교차점: 중심축 평행 직선(높이 ±smallR)이 큰원과 만나는 점
    // 작은원 쪽(+axis 방향) 교차점 사용 → 직선이 큰원에서 작은원으로 이어짐
    const axisOffset = Math.sqrt(bigR * bigR - smallR * smallR);
    const bTop = {
      x: bigCenter.x + axisDx * axisOffset + nx * smallR,
      y: bigCenter.y + axisDy * axisOffset + ny * smallR,
    };
    const bBot = {
      x: bigCenter.x + axisDx * axisOffset - nx * smallR,
      y: bigCenter.y + axisDy * axisOffset - ny * smallR,
    };

    // 직선 1 (위): bTop → sTop
    // 직선 2 (아래): sBot → bBot
    const line1 = { x1: bTop.x, y1: bTop.y, x2: sTop.x, y2: sTop.y };
    const line2 = { x1: sBot.x, y1: sBot.y, x2: bBot.x, y2: bBot.y };

    // 큰원 호: bTop → bBot (바깥쪽 = 작은원 반대편, 넓은 호)
    // bTop 각도 = axisAngle + asin(smallR/bigR), bBot 각도 = axisAngle - asin(smallR/bigR)
    // CCW: bTop → ... → PI+axisAngle → ... → bBot (넓은 호)
    const halfAngle = Math.asin(smallR / bigR);
    const bigArcStart = axisAngle + halfAngle;
    const bigArcEnd = axisAngle - halfAngle;

    // 작은원 호: sBot → sTop (바깥쪽 = 큰원 반대편, 반원)
    // CCW: sBot(axisAngle-PI/2) → axisAngle(작은원 쪽) → sTop(axisAngle+PI/2)
    // → 큰원 반대편 반원 ✓
    const smallArcStart = axisAngle - Math.PI / 2;
    const smallArcEnd = axisAngle + Math.PI / 2;

    return {
      bigArc: { startAngle: bigArcStart, endAngle: bigArcEnd },
      smallArc: { startAngle: smallArcStart, endAngle: smallArcEnd },
      line1,
      line2,
    };
  }

  private _buildPreviews(
    bigCenter: { x: number; y: number },
    smallCenter: { x: number; y: number },
    smallR: number,
    bigR: number,
  ): SerializedGeometry[] {
    const result = this._computeKeyhole(bigCenter, smallCenter, smallR, bigR);
    if (!result) return [];

    return [
      { type: "arc", id: "__kh_big__", cx: bigCenter.x, cy: bigCenter.y, r: bigR,
        startAngle: result.bigArc.startAngle, endAngle: result.bigArc.endAngle },
      { type: "line", id: "__kh_line1__",
        x1: result.line1.x1, y1: result.line1.y1,
        x2: result.line1.x2, y2: result.line1.y2 },
      { type: "arc", id: "__kh_small__", cx: smallCenter.x, cy: smallCenter.y, r: smallR,
        startAngle: result.smallArc.startAngle, endAngle: result.smallArc.endAngle },
      { type: "line", id: "__kh_line2__",
        x1: result.line2.x1, y1: result.line2.y1,
        x2: result.line2.x2, y2: result.line2.y2 },
    ];
  }

  private _finalize(
    store: SketchGeometryStore,
    bigR: number,
  ): void {
    if (!this._bigCenter || !this._smallCenter) return;

    const result = this._computeKeyhole(this._bigCenter, this._smallCenter, this._smallR, bigR);
    if (!result) {
      this.cancel();
      return;
    }

    const bigArcId = this._generateId();
    const smallArcId = this._generateId();
    const lineId1 = this._generateId();
    const lineId2 = this._generateId();

    const geoms: SerializedGeometry[] = [
      { type: "arc", id: bigArcId, cx: this._bigCenter.x, cy: this._bigCenter.y, r: bigR,
        startAngle: result.bigArc.startAngle, endAngle: result.bigArc.endAngle },
      { type: "line", id: lineId1,
        x1: result.line1.x1, y1: result.line1.y1,
        x2: result.line1.x2, y2: result.line1.y2 },
      { type: "arc", id: smallArcId, cx: this._smallCenter.x, cy: this._smallCenter.y, r: this._smallR,
        startAngle: result.smallArc.startAngle, endAngle: result.smallArc.endAngle },
      { type: "line", id: lineId2,
        x1: result.line2.x1, y1: result.line2.y1,
        x2: result.line2.x2, y2: result.line2.y2 },
    ];

    // 순환 연결: bigArc → line1 → smallArc → line2 → bigArc
    // arc vertex: 0=center, 1=start, 2=end
    // bigArc: v1=bTop(start), v2=bBot(end)  ← CCW bTop→back→bBot
    // smallArc: v1=sBot(start), v2=sTop(end)  ← CCW sBot→front→sTop
    // line1: v0=bTop, v1=sTop
    // line2: v0=sBot, v1=bBot
    let cIdx = 0;
    const cid = () => `cst_kh_${bigArcId}_${cIdx++}`;
    const constraints = [
      // bigArc.start(v1=bTop) ≡ line1.start(v0=bTop)
      { type: "coincident" as const, id: cid(), pointA: { geomId: bigArcId, vertexIndex: 1 }, pointB: { geomId: lineId1, vertexIndex: 0 } },
      // line1.end(v1=sTop) ≡ smallArc.end(v2=sTop)
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineId1, vertexIndex: 1 }, pointB: { geomId: smallArcId, vertexIndex: 2 } },
      // smallArc.start(v1=sBot) ≡ line2.start(v0=sBot)
      { type: "coincident" as const, id: cid(), pointA: { geomId: smallArcId, vertexIndex: 1 }, pointB: { geomId: lineId2, vertexIndex: 0 } },
      // line2.end(v1=bBot) ≡ bigArc.end(v2=bBot)
      { type: "coincident" as const, id: cid(), pointA: { geomId: lineId2, vertexIndex: 1 }, pointB: { geomId: bigArcId, vertexIndex: 2 } },
      // tangent 구속: 직선↔작은원
      { type: "tangent" as const, id: cid(), entityA: { geomId: lineId1 }, entityB: { geomId: smallArcId } },
      { type: "tangent" as const, id: cid(), entityA: { geomId: lineId2 }, entityB: { geomId: smallArcId } },
      // parallel 구속: 두 직선 평행 유지
      { type: "parallel" as const, id: cid(), lineA: { geomId: lineId1 }, lineB: { geomId: lineId2 } },
      // radius 구속: 반지름 고정
      { type: "radius" as const, id: cid(), circle: { geomId: bigArcId }, value: bigR },
      { type: "radius" as const, id: cid(), circle: { geomId: smallArcId }, value: this._smallR },
    ];

    const finalGeoms = this.constructionMode
      ? geoms.map((g) => ({ ...g, isConstruction: true }))
      : geoms;

    // Snap 기반 auto-constraint — click 0=bigCenter, click 1=smallCenter (arc center vertex 0).
    const autoCmds = this._buildSnapConstraints(store, [
      { clickIndex: 0, geomId: bigArcId, vertexIndex: 0 },
      { clickIndex: 1, geomId: smallArcId, vertexIndex: 0 },
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
