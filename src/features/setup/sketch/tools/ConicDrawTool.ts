// 원뿔 곡선(Conic) 그리기 도구: 5클릭 — 5점으로 일반 원뿔 곡선 정의
// 결과: NURBS 곡선 (5점 피팅에 의한 타원/포물선/쌍곡선)
// 점 위치에 따라 결과가 달라짐

import type { SketchDrawToolType } from "../../Setup.type";

import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// NURBS 근사 점 수
const NUM_POINTS = 41;

export class ConicDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "conic";

  private _points: { x: number; y: number }[] = [];

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    this._recordSnap(store);
    this._points.push({ ...snappedPos });

    if (this._points.length >= 5) {
      this._finalize(store);
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

    if (this._points.length >= 2 && this._points.length < 5) {
      // 현재까지의 점 + 마우스 위치로 프리뷰
      const allPoints = [...this._points, snappedPos];
      const curvePoints = this._fitConicPoints(allPoints);
      if (curvePoints.length >= 2) {
        this.preview = {
          type: "curve",
          id: "__preview__",
          points: curvePoints,
          degree: 3,
        };
      } else {
        this.preview = null;
      }
    } else if (this._points.length < 2) {
      // 클릭된 점들을 표시 (construction point)
      this.previews = this._points.map((p, i) => ({
        type: "point" as const,
        id: `__conic_pt_${i}__`,
        x: p.x,
        y: p.y,
        isConstruction: true,
      }));
      // 마우스 위치도 추가
      this.previews.push({
        type: "point" as const,
        id: "__conic_mouse__",
        x: snappedPos.x,
        y: snappedPos.y,
        isConstruction: true,
      });
      this.preview = null;
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  hasPendingWork(): boolean {
    return this._points.length > 0;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  cancel(): void {
    super.cancel();
    this._points = [];
  }

  // --- 내부 ---

  // 일반 원뿔 곡선 계수 피팅 (Ax² + Bxy + Cy² + Dx + Ey + F = 0)
  // 5점 → 6개 미지수, F=1로 고정하여 5x5 선형계
  private _fitConicCoeffs(
    points: { x: number; y: number }[],
  ): { A: number; B: number; C: number; D: number; E: number } | null {
    const n = points.length;
    if (n < 5) return null;

    // 수치 안정성을 위해 정규화
    let cx = 0, cy = 0;
    for (const p of points) { cx += p.x; cy += p.y; }
    cx /= n; cy /= n;
    let scale = 0;
    for (const p of points) scale += Math.hypot(p.x - cx, p.y - cy);
    scale = (scale / n) || 1;

    const normalized = points.map(p => ({
      x: (p.x - cx) / scale,
      y: (p.y - cy) / scale,
    }));

    // 5x5 행렬: 각 행 = [x², xy, y², x, y] * [A,B,C,D,E]' = -1 (F=1)
    // 최소자승: A'Ax = -A'1
    const rows = normalized.slice(0, 5).map(p => [
      p.x * p.x, p.x * p.y, p.y * p.y, p.x, p.y,
    ]);
    const rhs = [-1, -1, -1, -1, -1];

    // 가우스 소거법
    const mat = rows.map((row, i) => [...row, rhs[i]]);
    for (let col = 0; col < 5; col++) {
      // 피벗 선택
      let maxVal = Math.abs(mat[col][col]);
      let maxRow = col;
      for (let row = col + 1; row < 5; row++) {
        if (Math.abs(mat[row][col]) > maxVal) {
          maxVal = Math.abs(mat[row][col]);
          maxRow = row;
        }
      }
      if (maxVal < 1e-12) return null; // 특이 행렬
      if (maxRow !== col) [mat[col], mat[maxRow]] = [mat[maxRow], mat[col]];

      for (let row = col + 1; row < 5; row++) {
        const factor = mat[row][col] / mat[col][col];
        for (let j = col; j < 6; j++) {
          mat[row][j] -= factor * mat[col][j];
        }
      }
    }

    // 후진대입
    const sol = new Array<number>(5).fill(0);
    for (let i = 4; i >= 0; i--) {
      let sum = mat[i][5];
      for (let j = i + 1; j < 5; j++) {
        sum -= mat[i][j] * sol[j];
      }
      sol[i] = sum / mat[i][i];
    }

    // 역정규화: 원래 좌표계로 변환
    const [An, Bn, Cn, Dn, En] = sol;
    const s2 = scale * scale;
    const A = An / s2;
    const B = Bn / s2;
    const C = Cn / s2;
    const D = (Dn - 2 * An * cx - Bn * cy) / (s2 / scale);
    const E = (En - 2 * Cn * cy - Bn * cx) / (s2 / scale);

    return { A, B, C, D, E };
  }

  // 원뿔 곡선 위의 점들 생성 (implicit → parametric 샘플링)
  private _fitConicPoints(
    inputPoints: { x: number; y: number }[],
  ): { x: number; y: number }[] {
    if (inputPoints.length < 3) return [];

    const coeffs = this._fitConicCoeffs(inputPoints);
    if (!coeffs) {
      // 피팅 실패: 입력점을 통과하는 스플라인으로 폴백
      return inputPoints;
    }

    const { A, B, C, D, E } = coeffs;

    // 바운딩 박스 계산
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of inputPoints) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const margin = Math.max(maxX - minX, maxY - minY) * 0.3;
    minX -= margin; maxX += margin;
    minY -= margin; maxY += margin;

    // x를 스윕하면서 y를 이차 방정식으로 풀기
    // Cy² + (Bx+E)y + (Ax²+Dx+1) = 0
    const points: { x: number; y: number }[] = [];
    const centerY = (minY + maxY) / 2;

    for (let i = 0; i < NUM_POINTS; i++) {
      const x = minX + (maxX - minX) * i / (NUM_POINTS - 1);
      const qa = C;
      const qb = B * x + E;
      const qc = A * x * x + D * x + 1;
      const disc = qb * qb - 4 * qa * qc;

      if (Math.abs(qa) < 1e-12) {
        // 선형: y = -qc / qb
        if (Math.abs(qb) > 1e-12) {
          points.push({ x, y: -qc / qb });
        }
      } else if (disc >= 0) {
        const sqrtDisc = Math.sqrt(disc);
        const y1 = (-qb + sqrtDisc) / (2 * qa);
        const y2 = (-qb - sqrtDisc) / (2 * qa);
        // 입력점 중심에 가까운 해 선택
        const d1 = Math.abs(y1 - centerY);
        const d2 = Math.abs(y2 - centerY);
        points.push({ x, y: d1 <= d2 ? y1 : y2 });
      }
    }

    return points;
  }

  private _finalize(store: SketchGeometryStore): void {
    if (this._points.length < 5) {
      this.cancel();
      return;
    }

    const curvePoints = this._fitConicPoints(this._points);
    if (curvePoints.length < 2) {
      this.cancel();
      return;
    }

    const curveId = this._generateId();
    const addCmd = this._addGeometry({
      type: "curve",
      id: curveId,
      points: curvePoints,
      degree: 3,
    });

    // auto-constraint (첫 번째/마지막 클릭점)
    const autoConstraintCmds: GeometryCommand[] = [];
    const startCst = this._buildAutoConstraint(store, curveId, 0, this._snapPerClick[0]);
    if (startCst) autoConstraintCmds.push(startCst);
    const endCst = this._buildAutoConstraint(
      store, curveId, curvePoints.length - 1, this._snapPerClick[this._points.length - 1],
    );
    if (endCst) autoConstraintCmds.push(endCst);

    if (autoConstraintCmds.length > 0) {
      store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
    } else {
      store.execute(addCmd);
    }

    this.cancel();
    store.requestRender();
  }
}
