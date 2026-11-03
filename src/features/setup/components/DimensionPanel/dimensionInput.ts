// DimensionPanel 입력 문자열 ↔ 저장값 변환
// 표시는 반올림해도 원래 값을 보존하고, 사용자가 고친 경우만 반영한다 — 표시 문자열을 다시 환산하면
// 값을 안 바꾸고 OK 해도 치수가 반올림 오차만큼 바뀐다 (MKS 에서 12.5mm 가 "0.01" → 10mm).

import type { DimensionConstraintType } from "../../sketch/constraints/ConstraintValidator";

/**
 * 패널 첫 표시 문자열. 소수 2자리로 값이 그대로 나타나면 2자리 ("40.00"), 아니면 유효숫자
 * 6자리까지 보인다 — MKS 의 4mm 가 "0.00" 으로 보여 OK 가 비활성이 되지 않게.
 */
export function formatDimensionInput(display: number): string {
  const fixed2 = display.toFixed(2);
  if (Number(fixed2) === display) return fixed2;
  return String(Number(display.toPrecision(6)));
}

/**
 * 입력 문자열을 저장값 (length 는 mm, angle 은 °) 으로 바꾼다. 유효하지 않으면 null.
 * 입력이 처음 표시한 값과 같으면 반올림된 표시값을 다시 환산하지 않고 defaultValue 를 그대로 돌려준다.
 */
export function resolveDimensionInput(
  text: string,
  initialText: string,
  defaultValue: number,
  type: DimensionConstraintType,
  toStored: (display: number) => number,
): number | null {
  const parsed = parseFloat(text);
  if (isNaN(parsed)) return null;
  const unchanged = parsed === parseFloat(initialText);
  // 0 이하 / 360 이상 판정은 단위와 무관하므로 저장값으로 해도 같다.
  const value = unchanged ? defaultValue : toStored(parsed);
  if (type !== "line_angle" && value <= 0) return null;
  // angle: 0 < value < 360 — 사잇각 / 보각 / 반사각 / 보반사각 모두 허용
  if (type === "angle" && value >= 360) return null;
  return value;
}
