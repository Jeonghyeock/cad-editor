// 캔버스 영역 (.input-canvas) 위의 floating panel 위치 + 드래그 처리.
// DimensionPanel / Pad-Pocket-Panel / Revolve / Measure / Pattern / Plane Definition / Fillet-Chamfer
// 등 모든 floating panel 이 공유.

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

type Pos = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type PanelCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

const PAD = 4;

/** 캔버스 영역 bounding rect. selector 미일치 시 viewport. */
function getCanvasBounds(selector: string): Bounds {
  if (typeof document === "undefined") {
    return { minX: 0, minY: 0, maxX: 1920, maxY: 1080 };
  }
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) {
    return { minX: 0, minY: 0, maxX: window.innerWidth, maxY: window.innerHeight };
  }
  const r = el.getBoundingClientRect();
  return { minX: r.left, minY: r.top, maxX: r.right, maxY: r.bottom };
}

/** pos 를 panel 크기 고려해서 bounds 안으로 클램프. */
function clampToBounds(pos: Pos, w: number, h: number, b: Bounds): Pos {
  const maxX = Math.max(b.minX + PAD, b.maxX - w - PAD);
  const maxY = Math.max(b.minY + PAD, b.maxY - h - PAD);
  return {
    x: Math.min(Math.max(pos.x, b.minX + PAD), maxX),
    y: Math.min(Math.max(pos.y, b.minY + PAD), maxY),
  };
}

export type FloatingPanelDrag = {
  /** root 에 적용할 ref — panel 크기 측정 / 클램프 용. */
  panelRef: React.RefObject<HTMLDivElement | null>;
  /** root 의 inline style — `position: fixed; left/top` 또는 초기 hidden. */
  posStyle: React.CSSProperties;
  /** drag handle (보통 panel header) 에 spread 할 props. */
  dragHandleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
};

/**
 * Floating panel 의 초기 위치 (캔버스 모서리) + drag 이동 + bounds 클램프.
 *
 * - 첫 mount 시 `initialCorner` + `margin` 으로 초기 좌표 계산 (panel 실측 size 기반).
 * - 사용자가 header drag 하면 그 위치로 fixed (이후 캔버스 resize 에 자동 추적 안 함 — 사용자
 *   의지 우선). resize 시 panel 이 화면 밖으로 나가면 다음 drag/render 에 클램프.
 * - cursor 스타일은 SCSS 에서 처리 (CLAUDE.md 규칙 — 코드에서 cursor 변경 금지).
 */
export function useFloatingPanelDrag(
  initialCorner: PanelCorner = "top-right",
  margin = 16,
  /** 캔버스 element querySelector — default `.input-canvas`. result 페이지 등에서
   *  override 가능 (`.result__viewport`). */
  canvasSelector: string = ".input-canvas",
): FloatingPanelDrag {
  // 사용자가 drag 안 했을 때 — corner anchor CSS (right/bottom 또는 left/top) 로 위치 잡음.
  // panel size 무관 — viewport 기준 distance 라 panel 의 dynamic resize 와 무관하게 정확.
  // 사용자가 drag 하면 그 좌표로 fixed (left/top).
  const [anchorOffsets, setAnchorOffsets] = useState<{ rightDist: number; leftDist: number; topDist: number; bottomDist: number } | null>(null);
  const [draggedPos, setDraggedPos] = useState<Pos | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // canvas / viewport bounds 변화에 따라 anchor offsets 재계산 (panel size 무관).
  useLayoutEffect(() => {
    const compute = () => {
      const b = getCanvasBounds(canvasSelector);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // canvas 의 right/bottom edge 까지의 viewport-relative distance.
      const rightDist = Math.max(PAD, vw - b.maxX + margin);
      const bottomDist = Math.max(PAD, vh - b.maxY + margin);
      const leftDist = Math.max(PAD, b.minX + margin);
      const topDist = Math.max(PAD, b.minY + margin);
      setAnchorOffsets({ rightDist, leftDist, topDist, bottomDist });
    };
    compute();
    window.addEventListener("resize", compute);
    let canvasRO: ResizeObserver | null = null;
    const canvasEl = typeof document !== "undefined" ? document.querySelector(canvasSelector) : null;
    if (typeof ResizeObserver !== "undefined" && canvasEl) {
      canvasRO = new ResizeObserver(compute);
      canvasRO.observe(canvasEl);
    }
    return () => {
      window.removeEventListener("resize", compute);
      canvasRO?.disconnect();
    };
  }, [margin, canvasSelector]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // drag 시작 시 현재 panel 의 viewport-relative left/top 좌표를 캡처.
    // header 안의 interactive element (close button / 입력 등) 은 자체 onPointerDown 에서
    // stopPropagation 해야 setPointerCapture 가 click event 를 차단하지 않음.
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDraggedPos({ x: r.left, y: r.top });
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const el = panelRef.current;
    const w = el?.offsetWidth ?? 240;
    const h = el?.offsetHeight ?? 200;
    const raw = {
      x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
    };
    setDraggedPos(clampToBounds(raw, w, h, getCanvasBounds(canvasSelector)));
  }, [canvasSelector]);

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // posStyle:
  //  - draggedPos 있으면 left/top (사용자 위치)
  //  - 없으면 corner anchor CSS (right/bottom 또는 left/top distance) — panel size 무관.
  //  - anchorOffsets 도 측정 전이면 hidden (FOUC 방지).
  let posStyle: React.CSSProperties;
  if (draggedPos) {
    posStyle = { position: "fixed", left: draggedPos.x, top: draggedPos.y, right: "auto", bottom: "auto" };
  } else if (anchorOffsets) {
    const { rightDist, leftDist, topDist, bottomDist } = anchorOffsets;
    const isRight = initialCorner === "top-right" || initialCorner === "bottom-right";
    const isBottom = initialCorner === "bottom-left" || initialCorner === "bottom-right";
    posStyle = {
      position: "fixed",
      ...(isRight ? { right: rightDist, left: "auto" } : { left: leftDist, right: "auto" }),
      ...(isBottom ? { bottom: bottomDist, top: "auto" } : { top: topDist, bottom: "auto" }),
    };
  } else {
    posStyle = { visibility: "hidden" };
  }

  return {
    panelRef,
    posStyle,
    dragHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      style: { touchAction: "none", userSelect: "none" },
    },
  };
}

/**
 * 단순 corner pinning (드래그 없음) — 호환용. window resize / 캔버스 layout 변화 시 자동 재배치.
 * 신규 panel 은 useFloatingPanelDrag 우선 사용.
 */
export function useCanvasCornerPosition(
  corner: PanelCorner,
  margin = 16,
): React.CSSProperties {
  const [pos, setPos] = useState<Pos | null>(null);

  useLayoutEffect(() => {
    const compute = () => {
      const b = getCanvasBounds(".input-canvas");
      let x: number, y: number;
      switch (corner) {
        case "top-left":     x = b.minX + margin; y = b.minY + margin; break;
        case "top-right":    x = b.maxX - margin; y = b.minY + margin; break;
        case "bottom-left":  x = b.minX + margin; y = b.maxY - margin; break;
        case "bottom-right": x = b.maxX - margin; y = b.maxY - margin; break;
      }
      setPos({ x, y });
    };
    compute();
    window.addEventListener("resize", compute);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      const el = typeof document !== "undefined"
        ? document.querySelector(".input-canvas")
        : null;
      if (el) {
        ro = new ResizeObserver(compute);
        ro.observe(el);
      }
    }

    return () => {
      window.removeEventListener("resize", compute);
      if (ro) ro.disconnect();
    };
  }, [corner, margin]);

  if (!pos) return {};
  const style: React.CSSProperties = { position: "fixed" };
  if (corner === "top-right" || corner === "bottom-right") {
    style.right = window.innerWidth - pos.x;
    style.left = "auto";
  } else {
    style.left = pos.x;
    style.right = "auto";
  }
  if (corner === "bottom-left" || corner === "bottom-right") {
    style.bottom = window.innerHeight - pos.y;
    style.top = "auto";
  } else {
    style.top = pos.y;
    style.bottom = "auto";
  }
  return style;
}
