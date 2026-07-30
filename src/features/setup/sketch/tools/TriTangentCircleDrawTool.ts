// 3개 기하에 접하는 원 그리기 도구 (Tri-Tangent Circle)
// 3클릭: line, circle, arc 중 3개를 선택하여 모두에 접하는 원 생성
// 3 line → incircle/excircle 해석해, 혼합 → 반복 솔버

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

type TangentElement = {
  geom: SerializedGeometry;
};

export class TriTangentCircleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "tri-tangent-circle";


  selectionOnly = true;
  private _elements: TangentElement[] = [];

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    // 기하 히트 테스트
    const hitRadius = this.hitRadius;
    const hitId = store.hitTest(rawPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom) return;
    if (!this._isTangentable(geom)) return;

    // 중복 선택 방지
    if (this._elements.some((e) => e.geom.id === geom.id)) return;

    this._elements.push({ geom });

    if (this._elements.length === 3) {
      // 3개 요소에 접하는 원 계산
      const result = this._computeTriTangentCircle(this._elements);
      if (result) {
        const circleId = this._generateId();
        const addCmd = this._addGeometry({
          type: "circle",
          id: circleId,
          cx: result.cx,
          cy: result.cy,
          r: result.r,
        });

        // tangent 자동 구속
        const autoConstraintCmds: GeometryCommand[] = [];
        // 3개의 tangent 구속은 별도로 추가하지 않음 (솔버 부담 고려)

        if (autoConstraintCmds.length > 0) {
          store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
        } else {
          store.execute(addCmd);
        }
      }
      this._reset();
    }

    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    // 호버 하이라이트
    if (this._elements.length < 3) {
      const hitRadius = this.hitRadius;
      const hitId = store.hitTest(rawPos, hitRadius);
      if (hitId) {
        const geom = store.geometries.get(hitId);
        if (geom && this._isTangentable(geom)) {
          // 선택된 요소 하이라이트 + 호버 요소 하이라이트
          this.previews = [
            ...this._elements.map((e) => ({ ...e.geom, id: `__ttc_hl_${e.geom.id}__` })),
            { ...geom, id: `__ttc_hover_${geom.id}__` },
          ];
        } else {
          this.previews = this._elements.map((e) => ({ ...e.geom, id: `__ttc_hl_${e.geom.id}__` }));
        }
      } else {
        this.previews = this._elements.map((e) => ({ ...e.geom, id: `__ttc_hl_${e.geom.id}__` }));
      }

      // 2개 선택 후 마우스 위치에서 프리뷰 시도
      if (this._elements.length === 2 && hitId) {
        const hoverGeom = store.geometries.get(hitId);
        if (hoverGeom && this._isTangentable(hoverGeom)) {
          const result = this._computeTriTangentCircle([...this._elements, { geom: hoverGeom }]);
          if (result) {
            this.preview = {
              type: "circle",
              id: "__preview__",
              cx: result.cx,
              cy: result.cy,
              r: result.r,
            };
          } else {
            this.preview = null;
          }
        }
      }
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식이므로 pointerUp 처리 없음
  }

  hasPendingWork(): boolean {
    return this._elements.length > 0;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  override applyInputValues(
    _store: SketchGeometryStore,
    _values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    return false;
  }

  cancel(): void {
    super.cancel();
    this._reset();
  }

  // --- 접선 원 계산 ---

  private _computeTriTangentCircle(
    elements: TangentElement[],
  ): { cx: number; cy: number; r: number } | null {
    if (elements.length !== 3) return null;

    const types = elements.map((e) => e.geom.type);
    const allLines = types.every((t) => t === "line");

    if (allLines) {
      return this._threeLineIncircle(elements);
    }

    // 혼합 요소: Newton-Raphson 반복 솔버
    return this._iterativeSolve(elements);
  }

  // 3개 직선의 incircle (내접원)
  private _threeLineIncircle(
    elements: TangentElement[],
  ): { cx: number; cy: number; r: number } | null {
    const lines = elements.map((e) => {
      const g = e.geom;
      if (g.type !== "line") return null;
      return { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
    }).filter(Boolean) as { x1: number; y1: number; x2: number; y2: number }[];

    if (lines.length !== 3) return null;

    // 각 직선의 일반형 ax + by + c = 0
    const normals = lines.map((l) => {
      const dx = l.x2 - l.x1;
      const dy = l.y2 - l.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return null;
      // 법선: 반시계 90도 회전
      const a = -dy / len;
      const b = dx / len;
      const c = -(a * l.x1 + b * l.y1);
      return { a, b, c };
    }).filter(Boolean) as { a: number; b: number; c: number }[];

    if (normals.length !== 3) return null;

    // 8가지 부호 조합 중 가장 작은 반지름 양수 해 선택
    let bestResult: { cx: number; cy: number; r: number } | null = null;
    let bestR = Infinity;

    for (let signs = 0; signs < 8; signs++) {
      const s0 = (signs & 1) ? -1 : 1;
      const s1 = (signs & 2) ? -1 : 1;
      const s2 = (signs & 4) ? -1 : 1;
      const n = normals;

      // 3변수 연립 (x, y, r)
      // n[0].a * x + n[0].b * y - s0 * r = -s0 * n[0].c
      // n[1].a * x + n[1].b * y - s1 * r = -s1 * n[1].c
      // n[2].a * x + n[2].b * y - s2 * r = -s2 * n[2].c
      const A = [
        [n[0].a, n[0].b, -s0],
        [n[1].a, n[1].b, -s1],
        [n[2].a, n[2].b, -s2],
      ];
      const B = [-s0 * n[0].c, -s1 * n[1].c, -s2 * n[2].c];

      const result = this._solve3x3(A, B);
      if (!result) continue;

      const [cx, cy, r] = result;
      if (r > 0.1 && r < bestR) {
        bestR = r;
        bestResult = { cx, cy, r };
      }
    }

    return bestResult;
  }

  // 3x3 연립방정식 풀기 (Cramer)
  private _solve3x3(A: number[][], B: number[]): [number, number, number] | null {
    const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
              - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
              + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

    if (Math.abs(det) < 1e-12) return null;

    const x = (B[0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
             - A[0][1] * (B[1] * A[2][2] - A[1][2] * B[2])
             + A[0][2] * (B[1] * A[2][1] - A[1][1] * B[2])) / det;

    const y = (A[0][0] * (B[1] * A[2][2] - A[1][2] * B[2])
             - B[0] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
             + A[0][2] * (A[1][0] * B[2] - B[1] * A[2][0])) / det;

    const z = (A[0][0] * (A[1][1] * B[2] - B[1] * A[2][1])
             - A[0][1] * (A[1][0] * B[2] - B[1] * A[2][0])
             + B[0] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])) / det;

    return [x, y, z];
  }

  // 혼합 요소 Newton-Raphson 솔버
  private _iterativeSolve(
    elements: TangentElement[],
  ): { cx: number; cy: number; r: number } | null {
    // 초기 추정: 3개 요소의 대표 점의 무게중심
    const centers = elements.map((e) => this._getElementCenter(e.geom));
    let cx = (centers[0].x + centers[1].x + centers[2].x) / 3;
    let cy = (centers[0].y + centers[1].y + centers[2].y) / 3;
    let r = 10; // 초기 반지름 추정

    const MAX_ITER = 50;
    const TOL = 1e-6;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      // 각 요소까지의 부호 있는 거리
      const dists = elements.map((e) => this._signedDistToElement(cx, cy, e.geom));

      // 잔차: dist_i - r = 0
      const f0 = dists[0] - r;
      const f1 = dists[1] - r;
      const f2 = dists[2] - r;

      if (Math.abs(f0) < TOL && Math.abs(f1) < TOL && Math.abs(f2) < TOL) {
        if (r > 0.1) return { cx, cy, r };
        return null;
      }

      // 야코비안 (수치 미분)
      const h = 1e-6;
      const J: number[][] = [];
      for (let i = 0; i < 3; i++) {
        const d0 = this._signedDistToElement(cx, cy, elements[i].geom);
        const dxh = this._signedDistToElement(cx + h, cy, elements[i].geom);
        const dyh = this._signedDistToElement(cx, cy + h, elements[i].geom);
        J.push([(dxh - d0) / h, (dyh - d0) / h, -1]);
      }
      const F = [f0, f1, f2];

      const delta = this._solve3x3(J, F.map((v) => -v));
      if (!delta) return null;

      cx += delta[0];
      cy += delta[1];
      r += delta[2];

      if (r < 0) r = Math.abs(r);
    }

    return r > 0.1 ? { cx, cy, r } : null;
  }

  // 점에서 기하까지의 부호 있는 거리 (외부 양수)
  private _signedDistToElement(x: number, y: number, geom: SerializedGeometry): number {
    switch (geom.type) {
      case "line": {
        const dx = geom.x2 - geom.x1;
        const dy = geom.y2 - geom.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return Math.hypot(x - geom.x1, y - geom.y1);
        return Math.abs(dx * (geom.y1 - y) - dy * (geom.x1 - x)) / len;
      }
      case "circle":
        return Math.abs(Math.hypot(x - geom.cx, y - geom.cy) - geom.r);
      case "arc":
        return Math.abs(Math.hypot(x - geom.cx, y - geom.cy) - geom.r);
      default:
        return Infinity;
    }
  }

  // 기하 요소의 대표 점 (중심/중점)
  private _getElementCenter(geom: SerializedGeometry): { x: number; y: number } {
    switch (geom.type) {
      case "line":
        return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
      case "circle":
      case "arc":
        return { x: geom.cx, y: geom.cy };
      default:
        return { x: 0, y: 0 };
    }
  }

  // 접선 대상 가능 여부
  private _isTangentable(geom: SerializedGeometry): boolean {
    return geom.type === "line" || geom.type === "circle" || geom.type === "arc";
  }

  private _reset(): void {
    this._elements = [];
    this.preview = null;
    this.previews = [];
  }
}
