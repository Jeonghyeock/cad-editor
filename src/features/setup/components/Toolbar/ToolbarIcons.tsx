// 목업 (toolbar-wb 영역) 의 SVG 아이콘 추출. SetupToolbar 의
// 라벨 형식 (--labeled / rib-btn) 버튼에 사용. 외부 재사용 없음 — 본 파일 내 정의.
//
// 스타일 규약:
//  - viewBox 는 원본 그대로 (3D 그룹 32×32, 2D Sketch 14×14, RefGeom 32×32).
//  - stroke 색은 currentColor 로 통일 — toolbar `.tool-button` 의 cascade color
//    (gray-100 / hover white / active primary) 자동 적용. accent 색 (빨강 `#e15554`)
//    만 inline 유지 (디자인 의도 — 방향 표시).
//  - svg width/height 는 외부 CSS 가 결정 (`.tool-button svg { 24×24 }`,
//    `.rib-btn svg { 14×14 }`).

import React from "react";

const RED = "#e15554";

// ─────────────────────────────────────────────────────────────────────────
// 3D 그룹 (32×32, stroke-width 1.5–1.8)
// ─────────────────────────────────────────────────────────────────────────

export const TbUndo = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 13 H21 a6 6 0 0 1 0 12 H13" />
    <polyline points="14,8 9,13 14,18" />
  </svg>
);

export const TbRedo = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 13 H11 a6 6 0 0 0 0 12 H19" />
    <polyline points="18,8 23,13 18,18" />
  </svg>
);

export const TbPad = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <path d="M6 12 L18 7 L26 11 L26 21 L14 26 L6 22 Z" />
    <path d="M6 12 L14 16 L26 11 M14 16 L14 26" />
    <path d="M29 22 L29 6 M27 9 L29 6 L31 9" stroke={RED} />
  </svg>
);

export const TbPocket = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <path d="M5 10 L16 5 L27 10 L27 22 L16 27 L5 22 Z" />
    <path d="M5 10 L16 15 L27 10 M16 15 L16 27" />
    <ellipse cx="16" cy="10" rx="3.5" ry="1.3" />
    <path d="M21 3 L21 20 M19 18 L21 20 L23 18" stroke={RED} />
  </svg>
);

export const TbRevolve = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <ellipse cx="16" cy="10" rx="8" ry="2.2" />
    <line x1="8" y1="10" x2="8" y2="22" />
    <line x1="24" y1="10" x2="24" y2="22" />
    <path d="M 8 22 q 8 3 16 0" />
    <path d="M 22 4 a 8 4 0 0 1 -2 8" stroke={RED} />
    <polygon points="20,12 19,7.5 22.5,9" fill={RED} stroke="none" />
  </svg>
);

export const TbRefPlane = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <polygon points="6,20 16,14 26,20 16,26" />
    <line x1="16" y1="6" x2="16" y2="20" stroke={RED} />
    <polyline points="13,9 16,6 19,9" stroke={RED} />
  </svg>
);

export const TbSketchPlane = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <polygon points="4,18 16,11 28,18 16,25" />
    <path d="M 9 21 q 6 -7 13 -2" stroke={RED} />
  </svg>
);

export const TbExit = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <path d="M14 4 H6 a2 2 0 0 0 -2 2 V18 a2 2 0 0 0 2 2 H14" transform="translate(2 0)" />
    <line x1="10" y1="12" x2="20" y2="12" stroke={RED} transform="translate(-1 0)" />
    <polyline points="16,8 20,12 16,16" stroke={RED} transform="translate(-1 0)" />
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────
// 2D Sketch 그룹 (14×14, stroke-width 1.3)
// ─────────────────────────────────────────────────────────────────────────

export const TbProfile = () => (
  <svg viewBox="0 0 14 14">
    <polyline points="3,11 5,4 9,4 11,7 11,11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TbLine = () => (
  <svg viewBox="0 0 14 14">
    <line x1="3" y1="11" x2="11" y2="3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="3" cy="11" r="0.9" fill="currentColor" />
    <circle cx="11" cy="3" r="0.9" fill="currentColor" />
  </svg>
);

export const TbRect = () => (
  <svg viewBox="0 0 14 14">
    <rect x="3" y="4" width="8" height="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const TbORect = () => (
  <svg viewBox="0 0 14 14">
    <polygon points="3,9 8,3 11,5 6,11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

export const TbCircle = () => (
  <svg viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="7" cy="7" r="0.8" fill="currentColor" />
  </svg>
);

export const TbArc = () => (
  <svg viewBox="0 0 14 14">
    <path d="M3 11 A 6 6 0 0 1 11 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="3" cy="11" r="0.9" fill="currentColor" />
    <circle cx="11" cy="3" r="0.9" fill="currentColor" />
  </svg>
);

export const TbEllipse = () => (
  <svg viewBox="0 0 14 14">
    <ellipse cx="7" cy="7" rx="4.5" ry="2.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const TbSpline = () => (
  <svg viewBox="0 0 14 14">
    <path d="M3 10 Q 5 3, 7 7 T 11 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="3" cy="10" r="0.8" fill="currentColor" />
    <circle cx="11" cy="4" r="0.8" fill="currentColor" />
  </svg>
);

export const TbTrim = () => (
  <svg viewBox="0 0 14 14">
    <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" />
    <line x1="5" y1="3" x2="5" y2="11" stroke={RED} strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="5" cy="7" r="0.9" fill={RED} />
  </svg>
);

export const TbMirror = () => (
  <svg viewBox="0 0 14 14">
    <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" strokeWidth="1" strokeDasharray="1.5 1.5" />
    <polygon points="2,4 5,7 2,10" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <polygon points="12,4 9,7 12,10" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const TbOffset = () => (
  <svg viewBox="0 0 14 14">
    <path d="M3 11 L3 5 Q3 3 5 3 L11 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M5 11 L5 7 Q5 5 7 5 L11 5" fill="none" stroke="#60b4eb" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export const TbCorner = () => (
  <svg viewBox="0 0 14 14">
    <path d="M3 11 L3 6 Q3 3 6 3 L11 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <line x1="3" y1="11" x2="3" y2="6" stroke="#60b4eb" strokeWidth="0.6" strokeDasharray="1 1" />
    <line x1="11" y1="3" x2="6" y2="3" stroke="#60b4eb" strokeWidth="0.6" strokeDasharray="1 1" />
  </svg>
);

export const TbDim = () => (
  <svg viewBox="0 0 14 14">
    <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.3" />
    <polygon points="3,7 5,5.5 5,8.5" fill="currentColor" />
    <polygon points="11,7 9,5.5 9,8.5" fill="currentColor" />
    <line x1="3" y1="4" x2="3" y2="10" stroke="currentColor" strokeWidth="1" />
    <line x1="11" y1="4" x2="11" y2="10" stroke="currentColor" strokeWidth="1" />
  </svg>
);

export const TbConstr = () => (
  <svg viewBox="0 0 14 14">
    <rect x="4" y="6.5" width="6" height="4.5" rx="0.8" fill="none" stroke="#60b4eb" strokeWidth="1.3" />
    <path d="M5 6.5 V5 a2 2 0 0 1 4 0 V6.5" fill="none" stroke="#60b4eb" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export const TbConstruction = () => (
  <svg viewBox="0 0 14 14">
    <line x1="2" y1="7" x2="12" y2="7" stroke="#788087" strokeWidth="1.3" strokeDasharray="2 1.5" strokeLinecap="round" />
    <circle cx="2" cy="7" r="0.9" fill="#788087" />
    <circle cx="12" cy="7" r="0.9" fill="#788087" />
  </svg>
);

// Rectangle sub-menu (Predefined Profile) — Oriented Rect / Parallelogram / Elongated Hole /
// Cylindrical Elongated Hole / Keyhole / Hexagon / Centered Rect / Centered Parallelogram.

export const TbParallelogram = () => (
  <svg viewBox="0 0 14 14">
    <polygon points="2,11 5,3 12,3 9,11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

export const TbElongatedHole = () => (
  <svg viewBox="0 0 14 14">
    <path d="M4 4 H10 a3 3 0 0 1 0 6 H4 a3 3 0 0 1 0 -6 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const TbCylindricalElongatedHole = () => (
  <svg viewBox="0 0 14 14">
    <path d="M4 4 H10 a3 3 0 0 1 0 6 H4 a3 3 0 0 1 0 -6 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M4 7 H10" stroke="currentColor" strokeWidth="0.6" strokeDasharray="1 1" />
  </svg>
);

export const TbKeyhole = () => (
  <svg viewBox="0 0 14 14">
    <circle cx="7" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.6 6.5 L5.6 11 L8.4 11 L8.4 6.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

export const TbHexagon = () => (
  <svg viewBox="0 0 14 14">
    <polygon points="4.5,3 9.5,3 12,7 9.5,11 4.5,11 2,7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

export const TbCenteredRectangle = () => (
  <svg viewBox="0 0 14 14">
    <rect x="3" y="4" width="8" height="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <line x1="3" y1="4" x2="11" y2="10" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1 1" />
    <line x1="11" y1="4" x2="3" y2="10" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1 1" />
    <circle cx="7" cy="7" r="0.9" fill="currentColor" />
  </svg>
);

export const TbCenteredParallelogram = () => (
  <svg viewBox="0 0 14 14">
    <polygon points="2,11 5,3 12,3 9,11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <circle cx="7" cy="7" r="0.9" fill="currentColor" />
  </svg>
);

export const TbPoint = () => (
  <svg viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="1.6" fill="currentColor" />
    <line x1="3" y1="7" x2="4.5" y2="7" stroke="currentColor" strokeWidth="0.9" />
    <line x1="9.5" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="0.9" />
    <line x1="7" y1="3" x2="7" y2="4.5" stroke="currentColor" strokeWidth="0.9" />
    <line x1="7" y1="9.5" x2="7" y2="11" stroke="currentColor" strokeWidth="0.9" />
  </svg>
);

// Line sub-menu — Axis / Bisecting / Infinite / Bi-Tangent / Line Normal.

export const TbAxis = () => (
  <svg viewBox="0 0 14 14">
    <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 1.2" strokeLinecap="round" />
    <line x1="3" y1="5" x2="3" y2="9" stroke="currentColor" strokeWidth="1" />
    <line x1="11" y1="5" x2="11" y2="9" stroke="currentColor" strokeWidth="1" />
  </svg>
);

export const TbBisectingLine = () => (
  <svg viewBox="0 0 14 14">
    <line x1="2" y1="11" x2="12" y2="11" stroke="currentColor" strokeWidth="0.9" />
    <line x1="2" y1="11" x2="10" y2="3" stroke="currentColor" strokeWidth="0.9" />
    <line x1="2" y1="11" x2="9" y2="6" stroke="#60b4eb" strokeWidth="1.3" strokeDasharray="1.5 1" strokeLinecap="round" />
  </svg>
);

export const TbInfiniteLine = () => (
  <svg viewBox="0 0 14 14">
    <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.3" />
    <polyline points="4.5,5.5 3,7 4.5,8.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="9.5,5.5 11,7 9.5,8.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TbBiTangentLine = () => (
  <svg viewBox="0 0 14 14">
    <circle cx="4" cy="9.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1" />
    <circle cx="10" cy="4.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1" />
    <line x1="2" y1="8" x2="11.5" y2="3.5" stroke="#60b4eb" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export const TbLineNormal = () => (
  <svg viewBox="0 0 14 14">
    <line x1="2" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <line x1="7" y1="10" x2="7" y2="3" stroke="#60b4eb" strokeWidth="1.3" strokeLinecap="round" />
    <rect x="6" y="9" width="1.5" height="1.5" fill="none" stroke="#60b4eb" strokeWidth="0.7" />
  </svg>
);

// Point sub-menu — Point by Coordinates / Equidistant Points / Intersection Point.

export const TbPointByCoordinates = () => (
  <svg viewBox="0 0 14 14">
    <line x1="3" y1="12" x2="12" y2="12" stroke="currentColor" strokeWidth="0.9" />
    <line x1="3" y1="12" x2="3" y2="3" stroke="currentColor" strokeWidth="0.9" />
    <line x1="8" y1="12" x2="8" y2="5" stroke="currentColor" strokeWidth="0.4" strokeDasharray="1 1" />
    <line x1="3" y1="5" x2="8" y2="5" stroke="currentColor" strokeWidth="0.4" strokeDasharray="1 1" />
    <circle cx="8" cy="5" r="1.3" fill="#e15554" />
  </svg>
);

export const TbEquidistantPoints = () => (
  <svg viewBox="0 0 14 14">
    <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="0.9" />
    <circle cx="2" cy="7" r="1" fill="currentColor" />
    <circle cx="5.33" cy="7" r="1" fill="currentColor" />
    <circle cx="8.66" cy="7" r="1" fill="currentColor" />
    <circle cx="12" cy="7" r="1" fill="currentColor" />
  </svg>
);

export const TbIntersectionPoint = () => (
  <svg viewBox="0 0 14 14">
    <line x1="2" y1="11" x2="12" y2="3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    <line x1="2" y1="3" x2="12" y2="11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    <circle cx="7" cy="7" r="1.5" fill="#e15554" />
  </svg>
);

export const TbGridSnap = () => (
  <svg viewBox="0 0 14 14">
    <line x1="3" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="0.9" />
    <line x1="3" y1="9" x2="11" y2="9" stroke="currentColor" strokeWidth="0.9" />
    <line x1="5" y1="3" x2="5" y2="11" stroke="currentColor" strokeWidth="0.9" />
    <line x1="9" y1="3" x2="9" y2="11" stroke="currentColor" strokeWidth="0.9" />
    <circle cx="9" cy="5" r="1.4" fill="#60b4eb" />
  </svg>
);
