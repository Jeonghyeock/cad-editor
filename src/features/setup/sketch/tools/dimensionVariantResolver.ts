// Dimension 도구의 라벨 위치 → distance / h_distance / v_distance 자동 전환 로직.
// 순수 함수로 분리해 단위 테스트 가능. DimensionDrawTool 내부에서 사용.

import type { DimensionConstraintType } from "../constraints/ConstraintValidator";

export type DistanceVariant = "distance" | "horizontal_distance" | "vertical_distance";

/**
 * CATIA 9-영역 자동 감지. 두 점 (p1, p2) 의 bounding box 를 무한 연장한 9 영역 중
 * 라벨 위치로 타입 결정:
 *   - 위 / 아래 가장자리 (xRegion=center) → 수평 거리 (h_distance, |x2-x1|)
 *   - 좌 / 우 가장자리 (yRegion=between) → 수직 거리 (v_distance, |y2-y1|)
 *   - 4 모서리 + 중앙 → 실제 거리 (distance, euclidean)
 */
export function resolveDistanceVariant9Region(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  labelPos: { x: number; y: number },
): { type: DistanceVariant; value: number } {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const xRegion: "left" | "center" | "right" =
    labelPos.x < minX ? "left" : labelPos.x > maxX ? "right" : "center";
  const yRegion: "below" | "between" | "above" =
    labelPos.y < minY ? "below" : labelPos.y > maxY ? "above" : "between";

  if (xRegion === "center" && yRegion !== "between") {
    return { type: "horizontal_distance", value: Math.abs(p2.x - p1.x) };
  }
  if (yRegion === "between" && xRegion !== "center") {
    return { type: "vertical_distance", value: Math.abs(p2.y - p1.y) };
  }
  return { type: "distance", value: Math.hypot(p2.x - p1.x, p2.y - p1.y) };
}

/** distance 변종에 해당하는 타입인지 (자동 전환 대상) */
export function isDistanceVariant(t: DimensionConstraintType | null): boolean {
  return t === "distance" || t === "horizontal_distance" || t === "vertical_distance";
}
