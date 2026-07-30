// 오버레이 렌더링 공유 상수

// 구속조건 심볼 SVG 아이콘 URL (white 변형)
import coincidentIconUrl from "src/components/Icon/icons/coincident_icon_white.svg";
import colinearIconUrl from "src/components/Icon/icons/colinear_icon_white.svg";
import concentricIconUrl from "src/components/Icon/icons/concentric_icon_white.svg";
import dimensionIconUrl from "src/components/Icon/icons/dimension_icon_white.svg";
import horizontalIconUrl from "src/components/Icon/icons/horizontal_icon_white.svg";
import fixIconUrl from "src/components/Icon/icons/lock_icon_white.svg";
import midpointIconUrl from "src/components/Icon/icons/midpoint_icon_white.svg";
import parallelIconUrl from "src/components/Icon/icons/parallel_icon_white.svg";
import perpendicularIconUrl from "src/components/Icon/icons/perpendicular_icon_white.svg";
import symmetricIconUrl from "src/components/Icon/icons/symmetric_icon_white.svg";
import tangentIconUrl from "src/components/Icon/icons/tangent_icon_white.svg";
import verticalIconUrl from "src/components/Icon/icons/vertical_icon_white.svg";

import type { SnapType } from "../sketch/SnapEngine";

// --- 색상 상수 ---
// splash dark theme — sketch geometry 가 #1f2227 배경 위에 보이도록 light gray.
// selection (orange) / construction (orange) / inference (green) / snap (red) 와 구분 유지.
export const COLOR_GEOMETRY = 0xe5e8eb; // 기본 기하 색상 (light gray = $gray-100)
// hover / select 통일 톤 (linkage 와 동일) — sketch / 3D / linkage 가 모두 같은 색을 공유.
export const COLOR_HOVERED = 0xffaa44; // 호버 (연한 주황)
export const COLOR_SELECTED = 0xff8800; // 선택 (진한 주황)
// emissive 용 어두운 변형 — surface 위에 hover/select 색조 입힐 때 (3D body 등) 사용. 같은 hue 의 ~50%.
export const COLOR_HOVERED_EMISSIVE = 0x805522; // COLOR_HOVERED 1/2
export const COLOR_SELECTED_EMISSIVE = 0x804400; // COLOR_SELECTED 1/2
export const COLOR_PREVIEW = 0x9ca3af; // 프리뷰 (회색)
export const COLOR_SNAP = 0xef4444; // 스냅 인디케이터 (빨강)
export const COLOR_INFERENCE = 0x22c55e; // 추론선 (녹색)
export const COLOR_CONSTRUCTION = 0xf59e0b; // 보조선 (오렌지 — CATIA 스타일)
export const COLOR_REFERENCE = 0x9370db; // 외부 기하 참조 (보라)
// splash dark theme — reference geometry 가 검은 배경 위에 보이도록 흰색.
export const COLOR_REF_ORIGIN = 0xffffff; // 원점 마커
export const COLOR_DRIVEN_DIM = 0x9ca3af; // 참조 전용 dimension (회색)
export const COLOR_OVER_CONSTRAINED = 0xef4444; // over-constrained (빨강)
export const COLOR_FULLY_CONSTRAINED = 0xa855f7; // iso-constrained (보라 — CATIA V5R20+ / 3DEXPERIENCE 정합)
export const COLOR_TRIM_PREVIEW = 0xef4444; // trim 삭제 프리뷰 (빨강)
export const COLOR_CROSSHAIR = 0x788087; // crosshair 색상 (problem-definition과 동일 톤)
export const COLOR_CONSTRAINT = 0x06b6d4; // 구속조건 심볼 (cyan)
export const COLOR_FLASH = 0x38bdf8; // undo/redo 플래시 (밝은 파랑)
export const COLOR_DEPENDENCY = 0xfb923c; // Parent/Child 의존성 하이라이트 (주황)
export const COLOR_AXIS = 0xdc2626; // 축선 (빨간색 — CATIA 스타일 회전축)

// --- 크기 상수 ---
export const POINT_RADIUS = 0.8;
export const ARC_SEGMENTS = 48;
export const HANDLE_SCREEN_PX = 3.5; // vertex handle / point 반지름 (픽셀)
export const SNAP_SCREEN_PX = 10; // snap indicator 크기 (픽셀)
export const CROSSHAIR_SCREEN_PX = 12; // crosshair 반 길이 (픽셀)
export const AXIS_SCREEN_PX = 40; // 축선 시각적 길이 (픽셀) — hitTest 와 arrow 시각 길이 동기화
export const CONSTRAINT_LABEL_SCREEN_HEIGHT = 16; // 구속 라벨 높이 (픽셀)
export const CONSTRAINT_ICON_SIZE = 20; // 구속 아이콘 캔버스 크기 (픽셀)

// --- 구속 아이콘 ---

// 구속 타입 → SVG 아이콘 URL 매핑
export const CONSTRAINT_ICON_URLS: Record<string, string> = {
  horizontal: horizontalIconUrl,
  vertical: verticalIconUrl,
  coincident: coincidentIconUrl,
  tangent: tangentIconUrl,
  parallel: parallelIconUrl,
  perpendicular: perpendicularIconUrl,
  fix: fixIconUrl,
  midpoint: midpointIconUrl,
  concentric: concentricIconUrl,
  colinear: colinearIconUrl,
  distance: dimensionIconUrl,
  horizontal_distance: dimensionIconUrl,
  vertical_distance: dimensionIconUrl,
  line_length: dimensionIconUrl,
  angle: dimensionIconUrl,
  radius: dimensionIconUrl,
  diameter: dimensionIconUrl,
  point_line_distance: dimensionIconUrl,
  symmetric: symmetricIconUrl,
};

// 프리로딩된 아이콘 이미지 캐시
export const iconCache = new Map<string, HTMLImageElement>();
const _iconLoadPromises = new Map<string, Promise<HTMLImageElement>>();

export function preloadConstraintIcon(type: string): Promise<HTMLImageElement> {
  if (iconCache.has(type)) return Promise.resolve(iconCache.get(type)!);
  if (_iconLoadPromises.has(type)) return _iconLoadPromises.get(type)!;

  const url = CONSTRAINT_ICON_URLS[type];
  if (!url) return Promise.reject(new Error(`No icon for ${type}`));

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      iconCache.set(type, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
  _iconLoadPromises.set(type, promise);
  return promise;
}

// 모듈 로드 시 모든 구속 아이콘 프리로드
for (const type of Object.keys(CONSTRAINT_ICON_URLS)) {
  preloadConstraintIcon(type);
}

// 스냅 타입 → 표시 이름
export const SNAP_TYPE_LABELS: Record<SnapType, string> = {
  origin: "Origin",
  endpoint: "Endpoint",
  intersection: "Intersection",
  midpoint: "Midpoint",
  center: "Center",
  tangent: "Tangent",
  extension: "Extension",
  perpendicular: "Perpendicular",
  nearest: "Nearest",
  grid: "Grid",
};
