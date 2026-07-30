// Offset 도구: 기하 선택 → 거리 입력 → 원본과 평행한 새 기하 생성
// CATIA Offset 도구와 동일 동작 (2-상태 머신: idle → pending-input)

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddGeometryCommand } from "../commands/AddGeometryCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { nurbsEvaluate } from "../curveUtils";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapType } from "../SnapEngine";

import { DrawTool } from "./DrawTool";

type OffsetState = "idle" | "pending-input";

export type OffsetPendingState = {
  sourceGeom: SerializedGeometry;
  offsetSide: 1 | -1; // 법선 방향 기준 (+1 = 좌측/바깥, -1 = 우측/안쪽)
};

export type OffsetPropagationMode = "none" | "tangent";

export class OffsetDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "offset";

  // 스냅 필터: endpoint, nearest만 허용 (기하 body 위 스냅)
  snapFilter: Set<SnapType> | null = new Set<SnapType>(["endpoint", "nearest"]);

  // Offset 대기 상태
  pendingOffset: OffsetPendingState | null = null;

  // 전파 모드: "none" = 단일 요소, "tangent" = 접선 연결 체인
  propagationMode: OffsetPropagationMode = "none";

  // 양쪽 오프셋 여부
  bothSides = false;

  // 거리 입력 요청 콜백
  onRequestDistanceInput: ((state: OffsetPendingState) => void) | null = null;

  private _state: OffsetState = "idle";
  // 마지막 computePreview 시 사용된 거리 (side 변경 시 프리뷰 재갱신용)
  private _lastPreviewDistance = 0;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "pending-input") return;

    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(snappedPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom || !this._isOffsetable(geom)) return;

    // 오프셋 방향 결정
    const side = this._determineSide(geom, snappedPos);

    this.pendingOffset = { sourceGeom: geom, offsetSide: side };
    this._state = "pending-input";
    this._lastPreviewDistance = 0;

    // 소스 기하 하이라이트
    this.previews = [{ ...geom, id: `__offset_hl_${geom.id}__` }];
    store.requestRender();

    this.onRequestDistanceInput?.(this.pendingOffset);
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "pending-input") {
      // 방향 실시간 업데이트
      if (this.pendingOffset) {
        const newSide = this._determineSide(this.pendingOffset.sourceGeom, snappedPos);
        if (newSide !== this.pendingOffset.offsetSide) {
          this.pendingOffset = { ...this.pendingOffset, offsetSide: newSide };
          // side 변경 시 프리뷰 재갱신
          if (this._lastPreviewDistance > 0) {
            this.computePreview(store, this._lastPreviewDistance);
          }
        }
      }
      return;
    }

    // idle: 호버 하이라이트
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(snappedPos, hitRadius);

    if (hitId) {
      const geom = store.geometries.get(hitId);
      if (geom && this._isOffsetable(geom)) {
        this.previews = [{ ...geom, id: `__offset_hl_${geom.id}__` }];
        store.requestRender();
        return;
      }
    }

    if (this.previews.length > 0) {
      this.previews = [];
      store.requestRender();
    }
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // offset은 pointerDown에서 처리
  }

  onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.cancel();
      store.requestRender();
    }
  }

  hasPendingWork(): boolean {
    return this._state !== "idle";
  }

  cancel(): void {
    super.cancel();
    this.pendingOffset = null;
    this._state = "idle";
    this._lastPreviewDistance = 0;
  }

  // 프리뷰 업데이트: 현재 거리 값으로 오프셋 기하 미리보기
  computePreview(store: SketchGeometryStore, distance: number): void {
    this._lastPreviewDistance = distance;

    if (!this.pendingOffset || distance <= 0) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const result = this._computeOffsetGeometry(
      this.pendingOffset.sourceGeom,
      distance,
      this.pendingOffset.offsetSide,
    );

    if (result) {
      // 소스 하이라이트 + 오프셋 프리뷰
      this.previews = [
        { ...this.pendingOffset.sourceGeom, id: `__offset_hl_${this.pendingOffset.sourceGeom.id}__` },
        result,
      ];
    } else {
      this.previews = [
        { ...this.pendingOffset.sourceGeom, id: `__offset_hl_${this.pendingOffset.sourceGeom.id}__` },
      ];
    }
    store.requestRender();
  }

  // 거리 확정 시 호출
  applyOffset(store: SketchGeometryStore, distance: number): void {
    if (!this.pendingOffset) return;

    // 전파 모드: tangent 연결 체인 수집
    const sourceGeoms = this.propagationMode === "tangent"
      ? this._collectTangentChain(store, this.pendingOffset.sourceGeom)
      : [this.pendingOffset.sourceGeom];

    const cmds: AddGeometryCommand[] = [];

    for (const srcGeom of sourceGeoms) {
      const side = this.pendingOffset.offsetSide;

      const result = this._computeOffsetGeometry(srcGeom, distance, side);
      if (result) {
        cmds.push(new AddGeometryCommand({ ...result, id: this._generateId() }));
      }

      // 양쪽 오프셋
      if (this.bothSides) {
        const oppositeSide: 1 | -1 = side === 1 ? -1 : 1;
        const resultOpp = this._computeOffsetGeometry(srcGeom, distance, oppositeSide);
        if (resultOpp) {
          cmds.push(new AddGeometryCommand({ ...resultOpp, id: this._generateId() }));
        }
      }
    }

    if (cmds.length === 0) {
      this.cancel();
      return;
    }

    if (cmds.length === 1) {
      store.execute(cmds[0]);
    } else {
      store.execute(new BatchCommand(cmds));
    }

    this.pendingOffset = null;
    this._state = "idle";
    this._lastPreviewDistance = 0;
    this.preview = null;
    this.previews = [];
    this.inferenceLines = [];
    store.requestRender();
  }

  // --- 오프셋 기하 계산 ---

  private _computeOffsetGeometry(
    geom: SerializedGeometry,
    distance: number,
    side: 1 | -1,
  ): SerializedGeometry | null {
    switch (geom.type) {
      case "line":
        return this._offsetLine(geom, distance, side);
      case "circle":
        return this._offsetCircle(geom, distance, side);
      case "arc":
        return this._offsetArc(geom, distance, side);
      case "curve":
        return this._offsetCurve(geom, distance, side);
      default:
        return null;
    }
  }

  // Line: 법선 방향으로 평행이동
  private _offsetLine(
    line: SerializedGeometry & { type: "line" },
    distance: number,
    side: 1 | -1,
  ): SerializedGeometry | null {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;

    // 좌측 법선 (반시계 90도 회전)
    const nx = -dy / len * side * distance;
    const ny = dx / len * side * distance;

    return {
      type: "line",
      id: "__offset_result__",
      x1: line.x1 + nx,
      y1: line.y1 + ny,
      x2: line.x2 + nx,
      y2: line.y2 + ny,
    };
  }

  // Circle: 동심원 (바깥 또는 안쪽)
  private _offsetCircle(
    circle: SerializedGeometry & { type: "circle" },
    distance: number,
    side: 1 | -1,
  ): SerializedGeometry | null {
    // side = 1 → 바깥(반지름 증가), side = -1 → 안쪽(반지름 감소)
    const newR = circle.r + distance * side;
    if (newR <= 1e-6) return null;

    return {
      type: "circle",
      id: "__offset_result__",
      cx: circle.cx,
      cy: circle.cy,
      r: newR,
    };
  }

  // Arc: 동심 호 (각도 유지, 반지름 변경)
  private _offsetArc(
    arc: SerializedGeometry & { type: "arc" },
    distance: number,
    side: 1 | -1,
  ): SerializedGeometry | null {
    const newR = arc.r + distance * side;
    if (newR <= 1e-6) return null;

    return {
      type: "arc",
      id: "__offset_result__",
      cx: arc.cx,
      cy: arc.cy,
      r: newR,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
    };
  }

  // Curve (NURBS): 이산 근사 오프셋 → 새 제어점 생성
  private _offsetCurve(
    curve: SerializedGeometry & { type: "curve" },
    distance: number,
    side: 1 | -1,
  ): SerializedGeometry | null {
    // 곡선을 충분한 점으로 이산화
    const pts = nurbsEvaluate(curve.points, curve.degree, curve.knots, curve.weights, curve.points.length * 16);
    if (pts.length < 2) return null;

    // 각 점에서 법선 계산 → 오프셋
    const offsetPts: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const tLen = Math.hypot(tx, ty);
      if (tLen < 1e-12) {
        offsetPts.push(pts[i]);
        continue;
      }
      // 좌측 법선
      const nx = -ty / tLen;
      const ny = tx / tLen;
      offsetPts.push({
        x: pts[i].x + nx * distance * side,
        y: pts[i].y + ny * distance * side,
      });
    }

    // 오프셋 점 배열을 새 제어점으로 다운샘플 (원본과 동일 개수)
    const newControlPts = this._downsamplePoints(offsetPts, curve.points.length);

    return {
      type: "curve",
      id: "__offset_result__",
      points: newControlPts,
      degree: curve.degree,
      knots: curve.knots,
      weights: curve.weights,
    };
  }

  // 균등 간격으로 다운샘플
  private _downsamplePoints(
    pts: { x: number; y: number }[],
    targetCount: number,
  ): { x: number; y: number }[] {
    if (pts.length <= targetCount) return pts;
    const result: { x: number; y: number }[] = [];
    for (let i = 0; i < targetCount; i++) {
      const t = i / (targetCount - 1);
      const idx = t * (pts.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, pts.length - 1);
      const frac = idx - lo;
      result.push({
        x: pts[lo].x * (1 - frac) + pts[hi].x * frac,
        y: pts[lo].y * (1 - frac) + pts[hi].y * frac,
      });
    }
    return result;
  }

  // --- 방향 결정 ---

  private _determineSide(geom: SerializedGeometry, cursor: { x: number; y: number }): 1 | -1 {
    switch (geom.type) {
      case "line":
        return this._lineSignedDist(geom, cursor) >= 0 ? 1 : -1;
      case "circle":
      case "arc": {
        const dist = Math.hypot(cursor.x - geom.cx, cursor.y - geom.cy);
        return dist >= geom.r ? 1 : -1;
      }
      case "curve":
        return this._curveSignedDist(geom, cursor) >= 0 ? 1 : -1;
      default:
        return 1;
    }
  }

  // 선분의 signed distance (좌측 법선 방향이 양수)
  private _lineSignedDist(
    line: SerializedGeometry & { type: "line" },
    p: { x: number; y: number },
  ): number {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return 0;
    // signed distance = (p - p1) × dir / |dir|
    return ((p.x - line.x1) * (-dy) + (p.y - line.y1) * dx) / len;
  }

  // 곡선의 signed distance (가장 가까운 점에서 법선 기준)
  private _curveSignedDist(
    curve: SerializedGeometry & { type: "curve" },
    cursor: { x: number; y: number },
  ): number {
    const pts = nurbsEvaluate(curve.points, curve.degree, curve.knots, curve.weights, curve.points.length * 8);
    if (pts.length < 2) return 0;

    // 가장 가까운 점 찾기
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(cursor.x - pts[i].x, cursor.y - pts[i].y);
      if (d < minDist) {
        minDist = d;
        bestIdx = i;
      }
    }

    // 해당 점의 접선 → 법선
    const prev = pts[Math.max(0, bestIdx - 1)];
    const next = pts[Math.min(pts.length - 1, bestIdx + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-12) return 0;

    // 좌측 법선
    const nx = -ty / tLen;
    const ny = tx / tLen;
    return (cursor.x - pts[bestIdx].x) * nx + (cursor.y - pts[bestIdx].y) * ny;
  }

  // 오프셋 가능한 기하 타입인지 확인
  private _isOffsetable(geom: SerializedGeometry): boolean {
    if (("isReference" in geom && !!geom.isReference) || ("isConstruction" in geom && !!geom.isConstruction)) {
      return false;
    }
    return geom.type === "line" || geom.type === "circle" || geom.type === "arc" || geom.type === "curve";
  }

  // 접선 연결 체인 수집 (tangent propagation 모드)
  // 시작 기하에서 endpoint가 연결된 기하를 접선 방향으로 추적
  private _collectTangentChain(
    store: SketchGeometryStore,
    startGeom: SerializedGeometry,
  ): SerializedGeometry[] {
    const chain: SerializedGeometry[] = [startGeom];
    const visited = new Set<string>([startGeom.id]);
    const TOL = 1e-3;
    const TANGENT_DOT_THRESHOLD = 0.95; // ~18° 이내를 접선으로 간주

    // BFS: 끝점이 다른 기하의 끝점과 일치하고, 접선 방향이 유사한 경우 체인에 추가
    const queue = [startGeom];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentEndpoints = this._getEndpoints(current);

      for (const [, geom] of store.geometries) {
        if (visited.has(geom.id)) continue;
        if (!this._isOffsetable(geom)) continue;

        const geomEndpoints = this._getEndpoints(geom);

        // 끝점 매칭 확인
        for (const cep of currentEndpoints) {
          for (const gep of geomEndpoints) {
            const dist = Math.hypot(cep.x - gep.x, cep.y - gep.y);
            if (dist > TOL) continue;

            // 접선 방향 유사성 확인
            const cDir = this._getDirectionAt(current, cep);
            const gDir = this._getDirectionAt(geom, gep);
            if (!cDir || !gDir) continue;

            const dot = Math.abs(cDir.dx * gDir.dx + cDir.dy * gDir.dy);
            if (dot >= TANGENT_DOT_THRESHOLD) {
              visited.add(geom.id);
              chain.push(geom);
              queue.push(geom);
            }
          }
        }
      }
    }

    return chain;
  }

  // 기하의 끝점 목록 추출
  private _getEndpoints(geom: SerializedGeometry): { x: number; y: number }[] {
    switch (geom.type) {
      case "line":
        return [{ x: geom.x1, y: geom.y1 }, { x: geom.x2, y: geom.y2 }];
      case "arc": {
        const sx = geom.cx + geom.r * Math.cos(geom.startAngle);
        const sy = geom.cy + geom.r * Math.sin(geom.startAngle);
        const ex = geom.cx + geom.r * Math.cos(geom.endAngle);
        const ey = geom.cy + geom.r * Math.sin(geom.endAngle);
        return [{ x: sx, y: sy }, { x: ex, y: ey }];
      }
      case "circle":
        return []; // 원은 끝점 없음
      case "curve":
        if (geom.points.length < 2) return [];
        return [geom.points[0], geom.points[geom.points.length - 1]];
      default:
        return [];
    }
  }

  // 특정 끝점에서의 접선 방향 벡터 (정규화)
  private _getDirectionAt(
    geom: SerializedGeometry,
    endpoint: { x: number; y: number },
  ): { dx: number; dy: number } | null {
    switch (geom.type) {
      case "line": {
        const dx = geom.x2 - geom.x1;
        const dy = geom.y2 - geom.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return null;
        // 끝점이 p1이면 방향 그대로, p2이면 반대
        const dist1 = Math.hypot(endpoint.x - geom.x1, endpoint.y - geom.y1);
        const sign = dist1 < 0.01 ? 1 : -1;
        return { dx: sign * dx / len, dy: sign * dy / len };
      }
      case "arc": {
        // 호의 끝점에서의 접선: 반지름에 수직
        const angle = Math.atan2(endpoint.y - geom.cy, endpoint.x - geom.cx);
        // 반시계 방향 접선
        return { dx: -Math.sin(angle), dy: Math.cos(angle) };
      }
      default:
        return null;
    }
  }
}
