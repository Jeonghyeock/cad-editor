// NURBS(Non-Uniform Rational B-Spline) 곡선 평가 유틸리티

type Point2D = { x: number; y: number };

/**
 * clamped uniform knot vector 생성
 * 양끝에 (degree+1)개씩 반복, 내부는 균등 분할
 */
function generateClampedKnots(n: number, degree: number): number[] {
  const knotCount = n + degree + 1;
  const knots: number[] = [];
  for (let i = 0; i < knotCount; i++) {
    if (i <= degree) {
      knots.push(0);
    } else if (i >= knotCount - degree - 1) {
      knots.push(1);
    } else {
      knots.push((i - degree) / (n - degree));
    }
  }
  return knots;
}

/**
 * De Boor 알고리즘으로 NURBS 곡선의 한 점을 평가 (rational B-spline)
 *
 * 표준 공식 (The NURBS Book, Piegl & Tiller):
 *   d[j]^0 = P[j+k-p],  j = 0..p
 *   α_j^r  = (t - knots[j+k-p]) / (knots[j+k+1-r] - knots[j+k-p])
 *   d[j]^r = (1-α) * d[j-1]^{r-1} + α * d[j]^{r-1}
 *   결과   = d[p]^p
 */
function deBoor(
  t: number,
  degree: number,
  knots: number[],
  controlPoints: Point2D[],
  weights: number[],
): Point2D {
  const n = controlPoints.length;
  const p = degree;

  // t=1 처리: 마지막 유효 span으로 clamp
  if (t >= 1) t = 1 - 1e-10;

  // knot span 찾기: knots[k] <= t < knots[k+1]
  let k = p;
  for (let i = p; i < n; i++) {
    if (t >= knots[i] && t < knots[i + 1]) {
      k = i;
      break;
    }
  }

  // 동차 좌표로 초기화: d[j] = P[j+k-p] * w[j+k-p]
  const d: { wx: number; wy: number; w: number }[] = [];
  for (let j = 0; j <= p; j++) {
    const idx = j + k - p;
    const w = weights[idx];
    d.push({
      wx: controlPoints[idx].x * w,
      wy: controlPoints[idx].y * w,
      w,
    });
  }

  // De Boor 재귀
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const lowerKnot = knots[j + k - p];
      const upperKnot = knots[j + k + 1 - r];
      const denom = upperKnot - lowerKnot;
      const alpha = Math.abs(denom) < 1e-14 ? 0 : (t - lowerKnot) / denom;
      d[j] = {
        wx: (1 - alpha) * d[j - 1].wx + alpha * d[j].wx,
        wy: (1 - alpha) * d[j - 1].wy + alpha * d[j].wy,
        w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
      };
    }
  }

  const result = d[p];
  // 가중치가 0에 수렴하면 마지막 제어점으로 폴백
  if (Math.abs(result.w) < 1e-14) {
    const last = controlPoints[controlPoints.length - 1];
    return { x: last.x, y: last.y };
  }
  const invW = 1 / result.w;
  return { x: result.wx * invW, y: result.wy * invW };
}

/**
 * NURBS 곡선 평가
 * 제어점 배열을 받아 곡선 위의 포인트 배열을 반환
 * @param points 제어점 배열 (최소 2개)
 * @param degree NURBS 차수 (미지정 시 min(3, points.length - 1))
 * @param knots knot vector (미지정 시 clamped uniform 자동 생성)
 * @param weights 제어점별 가중치 (미지정 시 모두 1.0)
 * @param segments 곡선 세분화 수 (기본 points.length * 16)
 */
export function nurbsEvaluate(
  points: Point2D[],
  degree?: number,
  knots?: number[],
  weights?: number[],
  segments?: number,
): Point2D[] {
  if (points.length < 2) return [...points];
  // 2개 점이면 직선
  if (points.length === 2) return [...points];

  const n = points.length;
  const p = Math.min(degree ?? Math.min(3, n - 1), n - 1);
  const k = knots ?? generateClampedKnots(n, p);
  const w = weights ?? new Array(n).fill(1.0) as number[];
  const segs = segments ?? n * 16;

  const result: Point2D[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    result.push(deBoor(t, p, k, points, w));
  }

  return result;
}

