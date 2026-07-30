// 추론선(Inference Line) 계산 엔진
// 기하 기반 추론 (extension, tangent, alignment) + 방향 기반 추론 (HV, collinear, parallel, perpendicular)

import type { SerializedGeometry } from "../Setup.type";

import type { SnapResult } from "./SnapEngine";

export type InferenceLineType =
  | "hv" | "extension" | "collinear" | "parallel"
  | "perpendicular" | "tangent" | "alignment";

export type InferenceLine = {
  x1: number; y1: number;
  x2: number; y2: number;
  lineType: InferenceLineType;
  /** Ctrl-Lock 활성 시 true — 실선으로 렌더링 */
  isLocked?: boolean;
};

// 추론선 표시 길이 (월드 단위)
const INFERENCE_LINE_LENGTH = 500;
// 각도 임계값 (±5°)
const ANGLE_THRESHOLD = Math.PI / 36;

type Point = { x: number; y: number };

// --- 기하 기반 추론 (모든 DrawTool 공통) ---

/** extension, tangent, alignment 추론선 계산 */
export function computeGeometryInferences(
  cursor: Point,
  snapResult: SnapResult,
  geometries: SerializedGeometry[],
  radius: number,
): InferenceLine[] {
  const results: InferenceLine[] = [];

  // Extension 추론선: 스냅 타입이 extension이면 소스 line 찾아서 연장선 표시
  if (snapResult?.type === "extension") {
    const extLines = _computeExtensionInferences(snapResult, geometries);
    results.push(...extLines);
  }

  // Tangent 추론선: 스냅 타입이 tangent이면 접선 방향 표시
  if (snapResult?.type === "tangent") {
    const tanLines = _computeTangentInferences(snapResult, geometries);
    results.push(...tanLines);
  }

  // Alignment 추론선: key point와 H/V 정렬
  const alignLines = _computeAlignmentInferences(cursor, geometries, radius);
  results.push(...alignLines);

  return results;
}

// --- 방향 기반 추론 (LineDrawTool 전용) ---

/** HV, collinear, parallel, perpendicular 추론선 계산 */
export function computeDirectionalInferences(
  startPos: Point,
  endPos: Point,
  geometries: SerializedGeometry[],
  collinearThreshold: number,
): InferenceLine[] {
  const dx = endPos.x - startPos.x;
  const dy = endPos.y - startPos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return [];

  const angle = Math.atan2(dy, dx);

  // HV 검사
  const hvLines = _computeHVInferences(startPos, endPos, angle, dist);
  if (hvLines.length > 0) return hvLines; // HV 매칭 시 다른 방향 추론 스킵

  const results: InferenceLine[] = [];

  // 각 line 기하에 대해 collinear/parallel/perpendicular 검사
  for (const geom of geometries) {
    if (geom.type !== "line") continue;

    const gDx = geom.x2 - geom.x1;
    const gDy = geom.y2 - geom.y1;
    const gLen = Math.hypot(gDx, gDy);
    if (gLen < 1e-10) continue;

    const gAngle = Math.atan2(gDy, gDx);

    // 각도 차이 (mod π — 방향 무관)
    let angleDiff = Math.abs(angle - gAngle) % Math.PI;
    if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;

    // 수직 거리 계산 (startPos → 기하 무한직선)
    const perpDist = Math.abs(gDy * (startPos.x - geom.x1) - gDx * (startPos.y - geom.y1)) / gLen;

    if (angleDiff < ANGLE_THRESHOLD) {
      if (perpDist < collinearThreshold) {
        // Collinear: 같은 무한직선 위
        const line = _makeCollinearLine(startPos, endPos, geom);
        if (line) results.push(line);
      } else {
        // Parallel: 평행하지만 다른 직선
        results.push(..._makeParallelLines(startPos, angle, dist));
      }
    } else {
      // 직각 검사
      let perpAngleDiff = Math.abs(angleDiff - Math.PI / 2);
      if (perpAngleDiff > Math.PI / 4) perpAngleDiff = Math.PI / 2 - perpAngleDiff;

      if (perpAngleDiff < ANGLE_THRESHOLD) {
        results.push(..._makePerpendicularLines(startPos, angle, dist));
      }
    }
  }

  return results;
}

// --- Extension 헬퍼 ---

function _computeExtensionInferences(
  snap: NonNullable<SnapResult>,
  geometries: SerializedGeometry[],
): InferenceLine[] {
  // 스냅 포인트가 위치한 line의 연장선 찾기
  for (const geom of geometries) {
    if (geom.type !== "line") continue;

    const dx = geom.x2 - geom.x1;
    const dy = geom.y2 - geom.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) continue;

    // 스냅 포인트가 이 직선 위에 있는지 확인
    const t = ((snap.x - geom.x1) * dx + (snap.y - geom.y1) * dy) / lenSq;
    const projX = geom.x1 + t * dx;
    const projY = geom.y1 + t * dy;
    const distSq = (snap.x - projX) ** 2 + (snap.y - projY) ** 2;

    if (distSq < 0.01 && (t < -0.01 || t > 1.01)) {
      // 연장선 위에 있음 — 가까운 끝점에서 스냅 포인트까지 추론선
      const nearEnd = t < 0 ? { x: geom.x1, y: geom.y1 } : { x: geom.x2, y: geom.y2 };
      return [{
        x1: nearEnd.x, y1: nearEnd.y,
        x2: snap.x, y2: snap.y,
        lineType: "extension",
      }];
    }
  }
  return [];
}

// --- Tangent 헬퍼 ---

function _computeTangentInferences(
  snap: NonNullable<SnapResult>,
  geometries: SerializedGeometry[],
): InferenceLine[] {
  // 접점에 해당하는 원/호 찾기
  for (const geom of geometries) {
    if (geom.type !== "circle" && geom.type !== "arc") continue;

    const cx = geom.cx, cy = geom.cy, r = geom.r;
    // 스냅 포인트가 원/호 위에 있는지 확인
    const d = Math.hypot(snap.x - cx, snap.y - cy);
    if (Math.abs(d - r) > 0.1) continue;

    // 반지름 벡터 (중심 → 접점)
    const rx = (snap.x - cx) / d;
    const ry = (snap.y - cy) / d;

    // 접선 방향 (반지름에 수직)
    const tx = -ry;
    const ty = rx;

    const tanLen = r * 0.8;
    return [{
      x1: snap.x - tx * tanLen,
      y1: snap.y - ty * tanLen,
      x2: snap.x + tx * tanLen,
      y2: snap.y + ty * tanLen,
      lineType: "tangent",
    }];
  }
  return [];
}

// --- Alignment 헬퍼 ---

function _computeAlignmentInferences(
  cursor: Point,
  geometries: SerializedGeometry[],
  radius: number,
): InferenceLine[] {
  // 모든 기하의 key point 수집
  const keyPoints: Point[] = [];
  for (const geom of geometries) {
    switch (geom.type) {
      case "point":
        keyPoints.push({ x: geom.x, y: geom.y });
        break;
      case "line":
        keyPoints.push({ x: geom.x1, y: geom.y1 });
        keyPoints.push({ x: geom.x2, y: geom.y2 });
        keyPoints.push({ x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 });
        break;
      case "circle":
        keyPoints.push({ x: geom.cx, y: geom.cy });
        break;
      case "arc":
        keyPoints.push({ x: geom.cx, y: geom.cy });
        keyPoints.push({ x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) });
        keyPoints.push({ x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) });
        break;
      case "curve":
        if (geom.points.length > 0) {
          keyPoints.push(geom.points[0]);
          if (geom.points.length > 1) keyPoints.push(geom.points[geom.points.length - 1]);
        }
        break;
    }
  }

  const results: InferenceLine[] = [];
  let bestH: { point: Point; dist: number } | null = null;
  let bestV: { point: Point; dist: number } | null = null;
  const overshoot = radius * 0.5;

  for (const kp of keyPoints) {
    // 수평 정렬: Y좌표가 근접
    const dy = Math.abs(cursor.y - kp.y);
    if (dy < radius && dy > 1e-6 && (!bestH || dy < bestH.dist)) {
      bestH = { point: kp, dist: dy };
    }

    // 수직 정렬: X좌표가 근접
    const dx = Math.abs(cursor.x - kp.x);
    if (dx < radius && dx > 1e-6 && (!bestV || dx < bestV.dist)) {
      bestV = { point: kp, dist: dx };
    }
  }

  if (bestH) {
    const kp = bestH.point;
    const minX = Math.min(cursor.x, kp.x) - overshoot;
    const maxX = Math.max(cursor.x, kp.x) + overshoot;
    results.push({
      x1: minX, y1: kp.y,
      x2: maxX, y2: kp.y,
      lineType: "alignment",
    });
  }

  if (bestV) {
    const kp = bestV.point;
    const minY = Math.min(cursor.y, kp.y) - overshoot;
    const maxY = Math.max(cursor.y, kp.y) + overshoot;
    results.push({
      x1: kp.x, y1: minY,
      x2: kp.x, y2: maxY,
      lineType: "alignment",
    });
  }

  return results;
}

// --- HV 헬퍼 ---

function _computeHVInferences(
  startPos: Point,
  endPos: Point,
  angle: number,
  _dist: number,
): InferenceLine[] {
  const hvAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const gap = 3;

  for (const hvAngle of hvAngles) {
    let diff = Math.abs(angle - hvAngle);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;

    if (diff <= ANGLE_THRESHOLD) {
      const cosA = Math.cos(hvAngle);
      const sinA = Math.sin(hvAngle);
      return [
        // 시작점 바깥쪽
        {
          x1: startPos.x - INFERENCE_LINE_LENGTH * cosA,
          y1: startPos.y - INFERENCE_LINE_LENGTH * sinA,
          x2: startPos.x - gap * cosA,
          y2: startPos.y - gap * sinA,
          lineType: "hv",
        },
        // 끝점 바깥쪽
        {
          x1: endPos.x + gap * cosA,
          y1: endPos.y + gap * sinA,
          x2: endPos.x + INFERENCE_LINE_LENGTH * cosA,
          y2: endPos.y + INFERENCE_LINE_LENGTH * sinA,
          lineType: "hv",
        },
      ];
    }
  }
  return [];
}

// --- Collinear 헬퍼 ---

function _makeCollinearLine(
  startPos: Point,
  endPos: Point,
  geom: Extract<SerializedGeometry, { type: "line" }>,
): InferenceLine | null {
  // 기하와 그리는 선을 포함하는 공선 추론선
  const allX = [geom.x1, geom.x2, startPos.x, endPos.x];
  const allY = [geom.y1, geom.y2, startPos.y, endPos.y];

  const dx = geom.x2 - geom.x1;
  const dy = geom.y2 - geom.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-10) return null;

  const nx = dx / len;
  const ny = dy / len;
  const extend = 30;

  // 직선 방향으로 최소/최대 투영
  const projs = allX.map((x, i) => x * nx + allY[i] * ny);
  const minProj = Math.min(...projs) - extend;
  const maxProj = Math.max(...projs) + extend;

  // 기준점 (geom.x1, geom.y1) 기준 투영 오프셋
  const baseProj = geom.x1 * nx + geom.y1 * ny;

  return {
    x1: geom.x1 + (minProj - baseProj) * nx,
    y1: geom.y1 + (minProj - baseProj) * ny,
    x2: geom.x1 + (maxProj - baseProj) * nx,
    y2: geom.y1 + (maxProj - baseProj) * ny,
    lineType: "collinear",
  };
}

// --- Parallel 헬퍼 ---

function _makeParallelLines(
  startPos: Point,
  angle: number,
  dist: number,
): InferenceLine[] {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const extend = dist + 30;
  return [{
    x1: startPos.x - extend * cosA,
    y1: startPos.y - extend * sinA,
    x2: startPos.x + extend * cosA,
    y2: startPos.y + extend * sinA,
    lineType: "parallel",
  }];
}

// --- Perpendicular 헬퍼 ---

function _makePerpendicularLines(
  startPos: Point,
  angle: number,
  dist: number,
): InferenceLine[] {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const extend = dist + 30;
  return [{
    x1: startPos.x - extend * cosA,
    y1: startPos.y - extend * sinA,
    x2: startPos.x + extend * cosA,
    y2: startPos.y + extend * sinA,
    lineType: "perpendicular",
  }];
}

// --- Ctrl-Lock: 커서를 추론선 위로 투영 ---

/** 커서를 추론선(무한 직선) 위로 직교 투영 */
export function projectOntoInferenceLine(
  cursor: Point,
  line: InferenceLine,
): Point {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) return { x: line.x1, y: line.y1 };
  const t = ((cursor.x - line.x1) * dx + (cursor.y - line.y1) * dy) / lenSq;
  return { x: line.x1 + t * dx, y: line.y1 + t * dy };
}

// --- SmartPick: 추론선 교차점 계산 ---

/** 2개 이상의 추론선이 동시에 활성일 때 교차점 계산 */
export type InferenceIntersection = {
  x: number;
  y: number;
  sourceLines: InferenceLine[];
};

/** 추론선 쌍의 교차점을 계산하여 커서에 가장 가까운 것 반환 */
export function computeInferenceIntersections(
  lines: InferenceLine[],
  cursor: Point,
  radius: number,
): InferenceIntersection | null {
  if (lines.length < 2) return null;

  let best: InferenceIntersection | null = null;
  let bestDist2 = radius * radius;

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const pt = _intersectInferenceLines(lines[i], lines[j]);
      if (!pt) continue;

      const dx = cursor.x - pt.x;
      const dy = cursor.y - pt.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        best = { x: pt.x, y: pt.y, sourceLines: [lines[i], lines[j]] };
      }
    }
  }
  return best;
}

/** 두 추론선(무한 직선)의 교차점 */
function _intersectInferenceLines(
  a: InferenceLine,
  b: InferenceLine,
): Point | null {
  const d1x = a.x2 - a.x1, d1y = a.y2 - a.y1;
  const d2x = b.x2 - b.x1, d2y = b.y2 - b.y1;
  const denom = d1x * d2y - d1y * d2x;
  // 평행이면 교차 없음
  if (Math.abs(denom) < 1e-10) return null;

  const t = ((b.x1 - a.x1) * d2y - (b.y1 - a.y1) * d2x) / denom;
  return { x: a.x1 + t * d1x, y: a.y1 + t * d1y };
}
