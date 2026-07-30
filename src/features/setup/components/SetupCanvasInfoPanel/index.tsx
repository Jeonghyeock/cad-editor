// 캔버스 정보 오버레이 패널 — 스냅 타입/좌표 또는 선택된 기하/shape 속성 표시
// 우선순위: snap info > selection info
// length value 는 globalData.unit 따라 환산 (저장값 mm → display unit).

import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { useLengthUnit } from "src/shared/hooks/useLengthUnit";

import {
  setupConstraintSolveStatusAtom,
  setupDrawToolAtom,
  setupSelectionInfoAtom,
  setupSketchDofAtom,
  setupSnapDisplayAtom,
  setupViewModeAtom,
} from "../../Setup.store";
import type { SelectionPropertyInfo } from "../../Setup.type";

const cls = "input-canvas__info-panel";

type LU = ReturnType<typeof useLengthUnit>;
const fmt = (mm: number, lu: LU) => lu.toDisplay(mm).toFixed(1);

// 선택 정보를 표시 문자열로 변환
const renderSelectionInfo = (info: SelectionPropertyInfo, lu: LU): React.ReactNode => {
  switch (info.type) {
    case "point":
      return (
        <>
          <span className={`${cls}__type`}>Point</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>X: {fmt(info.x, lu)} {lu.label}</span>
          <span className={`${cls}__coord`}>Y: {fmt(info.y, lu)} {lu.label}</span>
        </>
      );
    case "line":
      return (
        <>
          <span className={`${cls}__type`}>Line</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>Length: {fmt(info.length, lu)} {lu.label}</span>
          <span className={`${cls}__coord`}>Angle: {info.angle.toFixed(1)}°</span>
        </>
      );
    case "circle":
      return (
        <>
          <span className={`${cls}__type`}>Circle</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>R: {fmt(info.r, lu)} {lu.label}</span>
          <span className={`${cls}__coord`}>Center: ({fmt(info.cx, lu)}, {fmt(info.cy, lu)}) {lu.label}</span>
        </>
      );
    case "arc":
      return (
        <>
          <span className={`${cls}__type`}>Arc</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>R: {fmt(info.r, lu)} {lu.label}</span>
          <span className={`${cls}__coord`}>Sweep: {info.sweep.toFixed(1)}°</span>
        </>
      );
    case "curve":
      return (
        <>
          <span className={`${cls}__type`}>Curve</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>Points: {info.controlPointCount}</span>
        </>
      );
    case "ellipse":
      return (
        <>
          <span className={`${cls}__type`}>Ellipse</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>Rx: {fmt(info.rx, lu)} {lu.label}</span>
          <span className={`${cls}__coord`}>Ry: {fmt(info.ry, lu)} {lu.label}</span>
        </>
      );
    case "polygon":
      return (
        <>
          <span className={`${cls}__type`}>Polygon</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>{info.vertexCount} vertices</span>
        </>
      );
    case "reference":
      return <span className={`${cls}__type`}>{info.name}</span>;
    case "shape":
      // Area 는 length² — 환산 factor 도 제곱. 단위 label 도 ². mm² 기본.
      return (
        <>
          <span className={`${cls}__type`}>Shape</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>
            Area: {(lu.toDisplay(Math.sqrt(info.area)) ** 2).toFixed(0)} {lu.label}²
          </span>
          <span className={`${cls}__coord`}>Edges: {info.edgeCount}</span>
        </>
      );
    case "multi":
      return (
        <>
          <span className={`${cls}__type`}>Selection</span>
          <span className={`${cls}__sep`}>|</span>
          <span className={`${cls}__coord`}>{info.count} items</span>
        </>
      );
  }
};

// CATIA 식 sketch solve status 라벨 — "Iso-Constrained", "Under-Constrained (N DOF)", "Over-Constrained" 등.
const formatSolveStatus = (status: string, dof: number): { label: string; color: string } | null => {
  switch (status) {
    case "fully-constrained":
      return { label: "Iso-Constrained", color: "#a855f7" };  // CATIA violet
    case "over-constrained":
      return { label: "Over-Constrained", color: "#ef4444" };
    case "error":
      return { label: "Inconsistent", color: "#fbbf24" };
    case "ok":
    case "under-constrained":
      if (dof > 0) return { label: `Under-Constrained (${dof} DOF)`, color: "#9ca3af" };
      return null;
    default:
      return null;
  }
};

const SetupCanvasInfoPanel = memo(() => {
  const snap = useAtomValue(setupSnapDisplayAtom);
  const selectionInfo = useAtomValue(setupSelectionInfoAtom);
  const viewMode = useAtomValue(setupViewModeAtom);
  const drawTool = useAtomValue(setupDrawToolAtom);
  const solveStatus = useAtomValue(setupConstraintSolveStatusAtom);
  const dof = useAtomValue(setupSketchDofAtom);
  const lu = useLengthUnit();

  if (viewMode !== "2d-section") return null;
  // drawTool (dimension / line / circle / 등) 활성 시 panel 숨김 — CATIA 와 동일하게
  // 도구 사용 중엔 status bar 같은 별도 표시만 (현재는 캔버스 위 floating 안 함).
  if (drawTool !== "select") return null;

  const solveInfo = formatSolveStatus(solveStatus, dof);

  // 우선순위: snap info > selection info > solve status
  if (snap) {
    return (
      <div className={cls}>
        <span className={`${cls}__type`}>{snap.type}</span>
        <span className={`${cls}__sep`}>|</span>
        <span className={`${cls}__coord`}>
          ({fmt(snap.x, lu)}, {fmt(snap.y, lu)}) {lu.label}
        </span>
      </div>
    );
  }

  if (selectionInfo) {
    return (
      <div className={cls}>
        {renderSelectionInfo(selectionInfo, lu)}
        {solveInfo && (
          <>
            <span className={`${cls}__sep`}>|</span>
            <span className={`${cls}__coord`} style={{ color: solveInfo.color }}>{solveInfo.label}</span>
          </>
        )}
      </div>
    );
  }

  // 선택 없을 때도 sketch solve status 표시 (CATIA 식 DOF 알림).
  if (solveInfo) {
    return (
      <div className={cls}>
        <span className={`${cls}__type`} style={{ color: solveInfo.color }}>{solveInfo.label}</span>
      </div>
    );
  }

  return null;
});

SetupCanvasInfoPanel.displayName = "SetupCanvasInfoPanel";

export default SetupCanvasInfoPanel;
