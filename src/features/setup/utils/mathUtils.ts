// 수학 유틸리티 — 각도 정규화, 히트테스트 거리 등 공유 로직

/**
 * 각도를 [0, 2π) 범위로 정규화
 */
export function normalizeAngle(angle: number): number {
  const a = angle % (Math.PI * 2);
  return a < 0 ? a + Math.PI * 2 : a;
}

/**
 * 각도가 start~end 호 범위 안에 있는지 확인 (0도 래핑 처리)
 * 모든 인자는 [0, 2π) 정규화된 값이어야 함
 */
export function isAngleBetween(angle: number, start: number, end: number): boolean {
  const a = normalizeAngle(angle);
  const s = normalizeAngle(start);
  const e = normalizeAngle(end);
  if (s <= e) return a >= s && a <= e;
  return a >= s || a <= e; // 0도를 걸치는 경우
}

/**
 * 점에서 선분까지의 거리 제곱
 * 히트테스트에서 sqrt 비용을 피하기 위해 제곱 값 반환
 */
export function pointToSegmentDist2(
  p: { x: number; y: number },
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (p.x - x1) ** 2 + (p.y - y1) ** 2;

  let t = ((p.x - x1) * dx + (p.y - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return (p.x - projX) ** 2 + (p.y - projY) ** 2;
}

/**
 * 점에서 무한 직선 (line A → B 가 결정하는 무한선) 까지의 수직 거리.
 * `pointToSegmentDist2` 와 다름 — 선분 끝점 너머에서도 perpendicular distance 반환.
 * 길이 0 인 line (a == b) 이면 점 a 까지 거리 반환.
 */
export function pointToLineDistance(
  p: { x: number; y: number },
  ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - ax, p.y - ay);
  // cross product magnitude / line length = perpendicular distance
  return Math.abs((p.x - ax) * dy - (p.y - ay) * dx) / len;
}

/**
 * 2D 벡터 (dx, dy) 를 단위 벡터로 정규화.
 * 길이 < eps 면 (0, 0) 반환 (호출자가 분기 처리해야 함).
 */
export function normalizeVector(
  dx: number,
  dy: number,
  eps = 1e-12,
): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len < eps) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}
