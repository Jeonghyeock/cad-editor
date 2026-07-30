/**
 * 직사각형 (x, y, width, height) 을 viewport 안으로 밀어 넣는다.
 *
 * Modal / Tooltip / Dropdown / ContextMenu 처럼 화면 한쪽 끝에서 열리는 floating 컴포넌트
 * 가 viewport 를 벗어나지 않도록 위치 조정. 우측 / 하단 초과 시 끌어당기고, 좌측 / 상단도
 * padding 확보.
 */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  padding = 4,
): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cx = x;
  let cy = y;
  if (cx + width > vw) cx = vw - width - padding;
  if (cx < padding) cx = padding;
  if (cy + height > vh) cy = vh - height - padding;
  if (cy < padding) cy = padding;
  return { x: cx, y: cy };
}
