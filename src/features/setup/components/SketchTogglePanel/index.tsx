// 스케치 토글 패널 — 그리드/스냅/Construction/구속조건 토글 버튼
// 스케치 모드(2d-section)에서 항상 표시, 드래그 가능한 타이틀바 포함

import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import Icon from "src/components/Icon";

import {
  setupAutoDimConstraintAtom,
  setupAutoGeoConstraintAtom,
  setupConnectContinuityAtom,
  setupConstraintVisibilityFilterAtom,
  setupConstraintVisibleAtom,
  setupConstructionModeAtom,
  setupDrawToolAtom,
  setupGridSnapEnabledAtom,
  setupGridSpacingAtom,
  setupGridSubdivisionsAtom,
  setupGridVisibleAtom,
  setupSnapEnabledAtom,
} from "../../Setup.store";
import { ConnectDrawTool } from "../../sketch/tools/ConnectDrawTool";
import type { DrawTool } from "../../sketch/tools/DrawTool";

// 구속조건 표시 토글 아이콘 (눈 모양)
const ConstraintVisibilityIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M9 4.5C5 4.5 2 9 2 9s3 4.5 7 4.5 7-4.5 7-4.5-3-4.5-7-4.5z" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

// 그리드 스냅 아이콘 (그리드 + 스냅 점)
const GridSnapIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 3h12v12H3z" stroke="currentColor" strokeWidth="1" />
    <path d="M3 9h12M9 3v12" stroke="currentColor" strokeWidth="0.6" />
    <circle cx="9" cy="9" r="1.8" fill="currentColor" />
  </svg>
);

// 기하 구속 필터 아이콘 (H/V/∥)
const GeometricFilterIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <text x="9" y="12" textAnchor="middle" fontSize="9" fontFamily="sans-serif" fontWeight="bold" fill="currentColor">H∥</text>
  </svg>
);

// 치수 구속 필터 아이콘 (⌀)
const DimensionalFilterIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <text x="9" y="13" textAnchor="middle" fontSize="12" fontFamily="sans-serif" fill="currentColor">⌀</text>
  </svg>
);

type SketchTogglePanelProps = {
  getDrawTool: () => DrawTool | null;
};

const DEFAULT_X = 200; // SpecTree 오른쪽 (SpecTree 너비 ~180px + 여백)
const DEFAULT_Y = 8;   // 상단 여백

const SketchTogglePanel = ({ getDrawTool }: SketchTogglePanelProps) => {
  const drawToolType = useAtomValue(setupDrawToolAtom);
  const [gridVisible, setGridVisible] = useAtom(setupGridVisibleAtom);
  const [gridSnapEnabled, setGridSnapEnabled] = useAtom(setupGridSnapEnabledAtom);
  const [snapEnabled, setSnapEnabled] = useAtom(setupSnapEnabledAtom);
  const [constructionMode, setConstructionMode] = useAtom(setupConstructionModeAtom);
  const [autoGeo, setAutoGeo] = useAtom(setupAutoGeoConstraintAtom);
  const [autoDim, setAutoDim] = useAtom(setupAutoDimConstraintAtom);
  const [constraintVisible, setConstraintVisible] = useAtom(setupConstraintVisibleAtom);
  const [constraintFilter, setConstraintFilter] = useAtom(setupConstraintVisibilityFilterAtom);
  const [gridSpacing, setGridSpacing] = useAtom(setupGridSpacingAtom);
  const [gridSubdivisions, setGridSubdivisions] = useAtom(setupGridSubdivisionsAtom);
  const [connectContinuity, setConnectContinuity] = useAtom(setupConnectContinuityAtom);

  const [position, setPosition] = useState<{ x: number; y: number }>({ x: DEFAULT_X, y: DEFAULT_Y });
  const [initialized, setInitialized] = useState(false);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 자동 구속 토글 상태를 도구에 동기화
  useEffect(() => {
    const t = getDrawTool();
    if (t) t.autoGeoConstraints = autoGeo;
  }, [autoGeo, getDrawTool, drawToolType]);

  // Construction 모드 상태를 도구에 동기화
  useEffect(() => {
    const t = getDrawTool();
    if (t) t.constructionMode = constructionMode;
  }, [constructionMode, getDrawTool, drawToolType]);


  // Connect 연속성 모드 상태를 ConnectDrawTool에 동기화
  useEffect(() => {
    const t = getDrawTool();
    if (t instanceof ConnectDrawTool) t.continuityMode = connectContinuity;
  }, [connectContinuity, getDrawTool, drawToolType]);

  // 초기 위치 설정 (부모 컨테이너 기준 하단-좌측)
  useEffect(() => {
    if (initialized) return;
    const parent = panelRef.current?.parentElement;
    if (parent) {
      const _parentRect = parent.getBoundingClientRect();
      const _panelHeight = panelRef.current?.offsetHeight ?? 60;
      setPosition({ x: DEFAULT_X, y: DEFAULT_Y });
      setInitialized(true);
    }
  }, [initialized]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    dragOffsetRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragOffsetRef.current) return;
      const p = panelRef.current;
      if (!p) {
        setPosition({
          x: ev.clientX - dragOffsetRef.current.x,
          y: ev.clientY - dragOffsetRef.current.y,
        });
        return;
      }
      const parentR = p.parentElement?.getBoundingClientRect();
      const panelR = p.getBoundingClientRect();
      const rawX = ev.clientX - dragOffsetRef.current.x;
      const rawY = ev.clientY - dragOffsetRef.current.y;
      if (!parentR) {
        setPosition({ x: rawX, y: rawY });
        return;
      }
      // 캔버스 영역 내부로 클램프 (parent = .input-canvas 가정)
      const PAD = 4;
      const maxX = Math.max(PAD, parentR.width - panelR.width - PAD);
      const maxY = Math.max(PAD, parentR.height - panelR.height - PAD);
      setPosition({
        x: Math.min(Math.max(rawX, PAD), maxX),
        y: Math.min(Math.max(rawY, PAD), maxY),
      });
    };

    const handleMouseUp = () => {
      dragOffsetRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [position]);

  const toggles = [
    { key: "grid", active: gridVisible, toggle: () => setGridVisible(!gridVisible), title: "Grid (Show/Hide)", IconComp: Icon.SketchGrid, disabled: false },
    { key: "grid-snap", active: gridSnapEnabled, toggle: () => setGridSnapEnabled(!gridSnapEnabled), title: "Snap to Grid", IconComp: GridSnapIcon, disabled: false },
    { key: "snap", active: snapEnabled, toggle: () => setSnapEnabled(!snapEnabled), title: "Snap to Point", IconComp: Icon.SketchSnap, disabled: false },
    { key: "construction", active: constructionMode, toggle: () => setConstructionMode(!constructionMode), title: "Construction/Standard Element (Q)", IconComp: Icon.SketchConstruction, disabled: false },
    { key: "geo", active: autoGeo, toggle: () => setAutoGeo(!autoGeo), title: "Geometrical Constraints", IconComp: Icon.SketchGeoConstraint, disabled: false },
    { key: "dim", active: autoDim, toggle: () => setAutoDim(!autoDim), title: "Dimensional Constraints Auto-Apply", IconComp: Icon.SketchDimConstraint, disabled: false },
    { key: "cst-vis", active: constraintVisible, toggle: () => setConstraintVisible(!constraintVisible), title: "Show/Hide Constraints", IconComp: ConstraintVisibilityIcon, disabled: false },
    { key: "cst-geo", active: constraintVisible && constraintFilter.geometric, toggle: () => setConstraintFilter({ ...constraintFilter, geometric: !constraintFilter.geometric }), title: "Show Geometric Constraints", IconComp: GeometricFilterIcon, disabled: !constraintVisible },
    { key: "cst-dim", active: constraintVisible && constraintFilter.dimensional, toggle: () => setConstraintFilter({ ...constraintFilter, dimensional: !constraintFilter.dimensional }), title: "Show Dimensional Constraints", IconComp: DimensionalFilterIcon, disabled: !constraintVisible },
  ];

  return (
    <div
      ref={panelRef}
      className="input__sketch-toggle-panel"
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="input__sketch-toggle-panel__titlebar"
        onMouseDown={handleMouseDown}
      >
        <span className="input__sketch-toggle-panel__titlebar-handle">&#8942;&#8942;</span>
        <span className="input__sketch-toggle-panel__titlebar-text">Sketch Tools</span>
      </div>
      <div className="input__sketch-toggle-panel__content">
        {toggles.map(({ key, active, toggle, title, IconComp, disabled }) => (
          <button
            key={key}
            className={`input__sketch-toggle-panel__toggle${active ? " input__sketch-toggle-panel__toggle--active" : ""}`}
            title={title}
            onClick={toggle}
            disabled={disabled}
          >
            <IconComp />
          </button>
        ))}
      </div>
      {/* 그리드 설정 (Grid 토글 옆 인라인 입력) */}
      {gridVisible && (
        <div className="input__sketch-toggle-panel__grid-settings">
          <label className="input__sketch-toggle-panel__grid-label">
            <span>Grid Spacing</span>
            <input
              type="number"
              className="input__sketch-toggle-panel__grid-input"
              value={gridSpacing}
              min={1}
              max={1000}
              step={1}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v > 0) setGridSpacing(v);
              }}
            />
          </label>
          <label className="input__sketch-toggle-panel__grid-label">
            <span>Subdivisions</span>
            <input
              type="number"
              className="input__sketch-toggle-panel__grid-input"
              value={gridSubdivisions}
              min={1}
              max={20}
              step={1}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v > 0) setGridSubdivisions(v);
              }}
            />
          </label>
        </div>
      )}
      {/* Connect 연속성 모드 (Connect 도구 활성 시만 표시) */}
      {drawToolType === "connect" && (
        <div className="input__sketch-toggle-panel__grid-settings" title="Connect Continuity (G0/G1/G2)">
          {(["G0", "G1", "G2"] as const).map((mode) => (
            <button
              key={mode}
              className={`input__sketch-toggle-panel__toggle${connectContinuity === mode ? " input__sketch-toggle-panel__toggle--active" : ""}`}
              title={mode === "G0" ? "Position Continuity" : mode === "G1" ? "Tangent Continuity" : "Curvature Continuity"}
              onClick={() => setConnectContinuity(mode)}
              style={{ fontSize: 10, width: 32 }}
            >{mode}</button>
          ))}
        </div>
      )}

    </div>
  );
};

export default memo(SketchTogglePanel);
