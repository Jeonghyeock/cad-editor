// 통일 floating panel — input 캔버스 위에 뜨는 모든 panel/dialog 의 공통 컨테이너.
// useFloatingPanelDrag + header + close button + body / 옵션 footer 자동.
// 목업 의 .params-panel / .material-panel 스타일 (input.scss 의 mixin) 사용.

import React, { type ReactNode } from "react";

import type { PanelCorner } from "../../hooks/useFloatingPanelDrag";
import { useFloatingPanelDrag } from "../../hooks/useFloatingPanelDrag";

type FloatingPanelProps = {
  /** Header 좌측에 표시할 타이틀. */
  title: ReactNode;
  /** Close button (×) 클릭 / 외부 닫기 trigger. 없으면 close button 숨김. */
  onClose?: () => void;
  /** Panel 폭 (px). 미지정 시 CSS default (또는 max-content). */
  width?: number;
  /** 초기 위치 corner (drag 전). default "top-right". */
  initialCorner?: PanelCorner;
  /** 캔버스 edge 와의 distance (px). default 16. */
  margin?: number;
  /** Root 에 추가할 className (panel-specific modifier 등). */
  className?: string;
  /** Body content. */
  children: ReactNode;
  /** Footer 영역 — 보통 OK/Cancel 같은 action button 들. */
  footer?: ReactNode;
};

export default function FloatingPanel({
  title,
  onClose,
  width,
  initialCorner = "top-right",
  margin = 16,
  className,
  children,
  footer,
}: FloatingPanelProps) {
  const { panelRef, posStyle, dragHandleProps } = useFloatingPanelDrag(initialCorner, margin);
  const rootStyle = width != null ? { ...posStyle, width } : posStyle;
  return (
    <div
      ref={panelRef}
      className={`input__floating-panel${className ? " " + className : ""}`}
      style={rootStyle}
    >
      <div className="input__floating-panel__header" {...dragHandleProps}>
        <span className="input__floating-panel__title">{title}</span>
        {onClose && (
          <button
            type="button"
            className="input__floating-panel__close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>
      <div className="input__floating-panel__body">{children}</div>
      {footer && <div className="input__floating-panel__footer">{footer}</div>}
    </div>
  );
}
