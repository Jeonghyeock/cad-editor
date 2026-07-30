// Input 피처 툴바 — 전체 아이콘 기반 tool-button 패턴

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import Icon from "src/components/Icon";

import {
  setupConstraintDialogOpenAtom,
  setupDrawToolAtom,
  setupGlobalCanRedoAtom,
  setupGlobalCanUndoAtom,
  setupSelectedFacesAtom,
  setupRefPlaneModeAtom,
  setupSelectionFilterAtom,
  setupSketchPlaneSelectionPendingAtom,
  setupViewModeAtom,
} from "../../Setup.store";
import type { SelectionFilterMode, SketchDrawToolType } from "../../Setup.type";

import {
  TbArc,
  TbAxis,
  TbBiTangentLine,
  TbBisectingLine,
  TbCenteredParallelogram,
  TbCenteredRectangle,
  TbCircle,
  TbConstr,
  TbCorner,
  TbCylindricalElongatedHole,
  TbDim,
  TbElongatedHole,
  TbEllipse,
  TbEquidistantPoints,
  TbExit,
  TbHexagon,
  TbInfiniteLine,
  TbIntersectionPoint,
  TbKeyhole,
  TbLine,
  TbLineNormal,
  TbMirror,
  TbORect,
  TbOffset,
  TbPad,
  TbParallelogram,
  TbPocket,
  TbPoint,
  TbPointByCoordinates,
  TbProfile,
  TbRect,
  TbRedo,
  TbRefPlane,
  TbRevolve,
  TbSketchPlane,
  TbSpline,
  TbTrim,
  TbUndo,
} from "./ToolbarIcons";


// CATIA User Selection Filter — single dropdown.
// enum value 는 단수형, UI 라벨은 CATIA 와 동일하게 복수형. 각 mode 에 isometric cube
// 베이스 아이콘 (all=cursor arrow, volume=fill, face=한 면, edge=한 변, vertex=한 점).
const SELECTION_FILTER_OPTIONS: SelectionFilterMode[] = ["all", "volume", "face", "edge", "vertex"];
const SELECTION_FILTER_LABELS: Record<SelectionFilterMode, string> = {
  all: "Selection",
  volume: "Volumes",
  face: "Faces",
  edge: "Edges",
  vertex: "Vertices",
};
const SELECTION_FILTER_ICONS: Record<SelectionFilterMode, React.FunctionComponent<React.SVGProps<SVGSVGElement>>> = {
  all: Icon.SelectAll,
  volume: Icon.SelectVolume,
  face: Icon.SelectFace,
  edge: Icon.SelectEdge,
  vertex: Icon.SelectVertex,
};

// 2D sketch mode toolbar Sketch 그룹 — flat list. Rect / Line / Point cell 은 sub-menu
// 부활 (기존 CATIA-식 dropdown 의 Predefined Profile / Line / Point sub 도구 노출).
// chevron 클릭 시 sub-menu 열림 → sub 클릭 시 그 도구 활성.
type SketchCellKind = "draw-tool" | "dimension" | "constr";
// label = cell/sub-menu 표시용 짧은 텍스트 (e.g. "Cyl. Elongated Hole"). tooltip = title
// 속성에 들어가는 풀 텍스트 (e.g. "Cylindrical Elongated Hole"). tooltip 미정의 시 label
// 그대로 사용.
type SketchSubTool = {
  type: SketchDrawToolType;
  icon?: React.FunctionComponent;
  iconClass: string;
  label: string;
  tooltip?: string;
  disabled?: boolean;
};
type SketchCell = {
  key: string;
  kind: SketchCellKind;
  toolType?: SketchDrawToolType;
  icon: React.FunctionComponent;
  iconClass: string;
  label: string;
  tooltip?: string;
  disabled?: boolean;
  subTools?: SketchSubTool[];
};
const SKETCH_CELLS: SketchCell[] = [
  { key: "profile",      kind: "draw-tool", toolType: "profile",             icon: TbProfile,      iconClass: "icon-profile",      label: "Profile" },
  {
    // 첫 sub = primary 도구 (Line). CATIA 패턴 — sub 선택 시 그 도구가 primary 가 됨.
    key: "line", kind: "draw-tool", toolType: "line", icon: TbLine, iconClass: "icon-segment", label: "Line",
    subTools: [
      { type: "line",            icon: TbLine,           iconClass: "icon-segment",        label: "Line" },
      { type: "axis",            icon: TbAxis,           iconClass: "icon-segment",        label: "Axis",            disabled: true },
      { type: "bisecting-line",  icon: TbBisectingLine,  iconClass: "icon-bisecting-line", label: "Bisecting Line",  disabled: true },
      { type: "infinite-line",   icon: TbInfiniteLine,   iconClass: "icon-segment",        label: "Infinite Line",   disabled: true },
      { type: "bi-tangent-line", icon: TbBiTangentLine,  iconClass: "icon-segment",        label: "Bi-Tangent Line", disabled: true },
      { type: "line-normal",     icon: TbLineNormal,     iconClass: "icon-segment",        label: "Line Normal",     disabled: true },
    ],
  },
  {
    // 첫 sub = primary 도구 (Rect).
    key: "rectangle", kind: "draw-tool", toolType: "rectangle", icon: TbRect, iconClass: "icon-rectangle", label: "Rect", tooltip: "Rectangle",
    subTools: [
      { type: "rectangle",                  icon: TbRect,                     iconClass: "icon-rectangle",                  label: "Rect",                 tooltip: "Rectangle" },
      { type: "oriented-rectangle",         icon: TbORect,                    iconClass: "icon-oriented-rectangle",         label: "Oriented Rect",        tooltip: "Oriented Rectangle" },
      { type: "parallelogram",              icon: TbParallelogram,            iconClass: "icon-parallelogram",              label: "Parallelogram" },
      { type: "elongated-hole",             icon: TbElongatedHole,            iconClass: "icon-elongated-hole",             label: "Elongated Hole" },
      { type: "cylindrical-elongated-hole", icon: TbCylindricalElongatedHole, iconClass: "icon-cylindrical-elongated-hole", label: "Cyl. Elongated Hole", tooltip: "Cylindrical Elongated Hole" },
      { type: "keyhole",                    icon: TbKeyhole,                  iconClass: "icon-keyhole",                    label: "Keyhole" },
      { type: "hexagon",                    icon: TbHexagon,                  iconClass: "icon-hexagon",                    label: "Hexagon" },
      { type: "centered-rectangle",         icon: TbCenteredRectangle,        iconClass: "icon-centered-rectangle",         label: "Centered Rect",        tooltip: "Centered Rectangle" },
      { type: "centered-parallelogram",     icon: TbCenteredParallelogram,    iconClass: "icon-centered-parallelogram",     label: "Centered Para.",       tooltip: "Centered Parallelogram" },
    ],
  },
  { key: "circle",       kind: "draw-tool", toolType: "circle",              icon: TbCircle,       iconClass: "icon-circle",       label: "Circle" },
  { key: "arc",          kind: "draw-tool", toolType: "arc",                 icon: TbArc,          iconClass: "icon-arc",          label: "Arc" },
  { key: "ellipse",      kind: "draw-tool", toolType: "ellipse",             icon: TbEllipse,      iconClass: "icon-ellipse",      label: "Ellipse",      disabled: true },
  { key: "spline",       kind: "draw-tool", toolType: "curve",               icon: TbSpline,       iconClass: "icon-curve",        label: "Spline",       disabled: true },
  {
    // 첫 sub = primary 도구 (Point).
    key: "point", kind: "draw-tool", toolType: "point", icon: TbPoint, iconClass: "icon-point", label: "Point",
    subTools: [
      { type: "point",              icon: TbPoint,              iconClass: "icon-point",              label: "Point" },
      { type: "point-coordinates",  icon: TbPointByCoordinates, iconClass: "icon-point-coordinates",  label: "Point by Coordinates", disabled: true },
      { type: "equidistant-points", icon: TbEquidistantPoints,  iconClass: "icon-equidistant-points", label: "Equidistant Points",   disabled: true },
      { type: "intersection-point", icon: TbIntersectionPoint,  iconClass: "icon-intersection-point", label: "Intersection Point",   disabled: true },
    ],
  },
  { key: "trim",         kind: "draw-tool", toolType: "trim",                icon: TbTrim,         iconClass: "icon-trim",         label: "Trim",         disabled: true },
  { key: "mirror",       kind: "draw-tool", toolType: "mirror",              icon: TbMirror,       iconClass: "icon-mirror",       label: "Mirror",       disabled: true },
  { key: "offset",       kind: "draw-tool", toolType: "offset",              icon: TbOffset,       iconClass: "icon-offset",       label: "Offset",       disabled: true },
  { key: "corner",       kind: "draw-tool", toolType: "corner",              icon: TbCorner,       iconClass: "icon-corner",       label: "Corner",       disabled: true },
  { key: "dimension",    kind: "dimension",                                  icon: TbDim,          iconClass: "icon-dimension",    label: "Dim",    tooltip: "Dimension" },
  { key: "constr",       kind: "constr",                                     icon: TbConstr,       iconClass: "icon-sketch-geo-constraint", label: "Constr", tooltip: "Constraint" },
  // Construction / Grid Snap 은 SketchTogglePanel 에 별도 토글로 존재 — 중복 방지 위해 toolbar 에서 제외.
];

type SetupToolbarProps = {
  onCloseSketch?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onImportFile?: (file: File) => Promise<void>;
  onStartPadPocket?: (type: "pad" | "pocket", planeKey: string) => void;
  onStartRevolve?: (planeKey: string) => void;
  onProjectEdges?: () => void;
  onProjectSilhouette?: () => void;
  onIntersect3D?: () => void;
  /** 이미지 파일 import — sketch 모드에서 background 이미지 추가 */
  onInsertImage?: (file: File) => void;
};

const noop = () => {};

const SetupToolbar = ({ onCloseSketch, onUndo, onRedo, onImportFile, onStartPadPocket, onStartRevolve, onProjectEdges, onProjectSilhouette, onIntersect3D, onInsertImage }: SetupToolbarProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const viewMode = useAtomValue(setupViewModeAtom);
  const sketchPending = useAtomValue(setupSketchPlaneSelectionPendingAtom);
  const setSketchPending = useSetAtom(setupSketchPlaneSelectionPendingAtom);
  const globalCanUndo = useAtomValue(setupGlobalCanUndoAtom);
  const globalCanRedo = useAtomValue(setupGlobalCanRedoAtom);
  const [selectionFilter, setSelectionFilter] = useAtom(setupSelectionFilterAtom);
  const setRefPlaneMode = useSetAtom(setupRefPlaneModeAtom);
  const drawToolType = useAtomValue(setupDrawToolAtom);
  const setDrawToolType = useSetAtom(setupDrawToolAtom);
  const selectedFaces = useAtomValue(setupSelectedFacesAtom);
  const [constraintDialogOpen, setConstraintDialogOpen] = useAtom(setupConstraintDialogOpenAtom);

  // CATIA식 드롭다운: 열린 그룹 ID (null이면 모두 닫힘)
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const toggleDropdown = useCallback((id: string) => {
    setOpenDropdown((prev) => (prev === id ? null : id));
  }, []);

  // 외부 클릭 시 드롭다운 닫기 — dropdown-wrapper 내부 (toggle button + menu) 외 클릭이면 close.
  useEffect(() => {
    if (!openDropdown) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest(".input-toolbar__dropdown-wrapper")) return;
      if (target.closest(".input-toolbar__rib-wrap")) return;
      setOpenDropdown(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openDropdown]);

  // sub-menu 가 있는 cell 의 마지막 선택 sub 도구 — CATIA 패턴 (sub 선택 시 그 sub 가 새
  // primary 가 되어 cell 의 icon/label 이 그 sub 로 교체됨). null = 초기값 = 원래 primary.
  const [groupActiveTool, setGroupActiveTool] = useState<Record<string, SketchSubTool>>({});

  const isSketchActive = viewMode === "2d-section";
  // sketch 평면 선택 대기 (sketchPending) 동안만 active. sketch 진입 후엔 Exit 버튼
  // 으로 라벨/아이콘만 swap — 토글 버튼이 아니므로 active 강조 없음.
  const isSketchBtnActive = sketchPending;
  const is3dMode = viewMode === "3d";
  // Pad/Pocket/Revolve는 face가 선택된 경우에만 활성화
  const canUse3dOps = is3dMode && selectedFaces.length > 0;

  // ESC 키: sketchPending 취소
  useEffect(() => {
    if (!sketchPending) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSketchPending(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sketchPending, setSketchPending]);

  const handleSketchClick = useCallback(() => {
    if (isSketchActive && onCloseSketch) {
      onCloseSketch();
    } else if (sketchPending) {
      // 평면 선택 대기 중 → 취소
      setSketchPending(false);
    } else {
      setSketchPending(true);
    }
  }, [isSketchActive, sketchPending, onCloseSketch, setSketchPending]);

  const handleChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await onImportFile?.(file);
      e.target.value = "";
    },
    [onImportFile],
  );

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z — SetupToolbar 가 라벨 버튼 + 단축키 둘 다 자체 처리.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey)) return;
      // input/textarea focus 시 OS-standard undo/redo 유지 — sketch undo 가 input typing
      // 의 undo 를 가로채던 회귀 차단.
      const target = e.target as HTMLElement | null;
      const isInputFocused = !!target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );
      if (isInputFocused) return;
      if ((e.shiftKey && key === "z") || key === "y") {
        e.preventDefault();
        if (globalCanRedo) onRedo?.();
      } else if (!e.shiftKey && key === "z") {
        e.preventDefault();
        if (globalCanUndo) onUndo?.();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [globalCanRedo, globalCanUndo, onRedo, onUndo]);

  return (
    <div className={`input-toolbar${isSketchActive ? " input-toolbar--sketch-mode" : ""}`}>
      <div className="input-toolbar__container">
        {/* Undo / Redo — html 시안 toolbar-wb 정합 (아이콘 위 + 라벨 아래). */}
        <button
          title="Undo (Ctrl+Z)"
          className="tool-button tool-button--labeled icon-undo"
          disabled={!globalCanUndo}
          onClick={onUndo ?? noop}
          type="button"
        >
          <TbUndo />
          <span className="tool-button__label">Undo</span>
        </button>
        <button
          title="Redo (Ctrl+Y)"
          className="tool-button tool-button--labeled icon-redo"
          disabled={!globalCanRedo}
          onClick={onRedo ?? noop}
          type="button"
        >
          <TbRedo />
          <span className="tool-button__label">Redo</span>
        </button>

        {/* 3D 모드에서는 그룹 separator 유지 (캡쳐 정합). 2D 모드 (Exit 표시) 에서는
            Undo/Redo/Exit/Import 가 한 흐름이므로 separator 제거. */}
        {is3dMode && <div className="input-toolbar__separator" />}

        {/* Sketch / Exit — 2D 진입/종료 토글. label 은 모드에 따라 swap.
            아이콘은 시안 정합 (3D=SketchPlane / 2D=Exit door). */}
        <button
          title={isSketchActive ? "Exit Sketch" : "2D Sketch"}
          className={`tool-button tool-button--labeled icon-sketch${isSketchBtnActive ? " active" : ""}`}
          onClick={handleSketchClick}
          type="button"
        >
          {isSketchActive ? <TbExit /> : <TbSketchPlane />}
          <span className="tool-button__label">{isSketchActive ? "Exit" : "2D Sketch"}</span>
        </button>

        {/* Reference Plane — CATIA "Plane" 도구 동등 (3D 모드 전용) */}
        {is3dMode && (
          <button
            title="Reference Plane"
            className="tool-button tool-button--labeled"
            onClick={() => setRefPlaneMode({ step: "select-plane", selectionMode: "face" })}
            type="button"
          >
            <TbRefPlane />
            <span className="tool-button__label">Ref. Plane</span>
          </button>
        )}

        {/* 3D 모드 separator — Ref.Plane 다음. 2D 모드는 한 흐름. */}
        {is3dMode && <div className="input-toolbar__separator" />}

        {/* Import STEP — 적당히 스타일 (사용자 요청). */}
        <button
          title="Import STEP"
          className="tool-button tool-button--labeled icon-import"
          onClick={handleClick}
          type="button"
        >
          <Icon.ImportStep />
          <span className="tool-button__label">Import</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".stp,.step,.STP,.STEP"
          onChange={handleChange}
          style={{ display: "none" }}
        />

        {/* 2D 스케치 모드 — Office Ribbon-style 그룹 (3-row column-first grid).
            Sketch 그룹 (모든 sketch 도구 flat). */}
        {isSketchActive && (
          <>
            <div className="input-toolbar__separator" />

            {/* Sketch 그룹 — SKETCH_CELLS + Project / Insert Image (props 동적). */}
            <div className="input-toolbar__rib-group">
              <div className="input-toolbar__rib-group-grid">
                {SKETCH_CELLS.map((cell) => {
                  // CATIA 패턴 — sub 선택 시 그 sub 가 cell 의 새 primary 가 됨.
                  // groupActiveTool[cell.key] 가 있으면 그 sub 의 icon/label/toolType 사용.
                  const activeSub = cell.subTools ? groupActiveTool[cell.key] : undefined;
                  const displayIcon = activeSub?.icon ?? cell.icon;
                  const displayLabel = activeSub?.label ?? cell.label;
                  const displayTooltip = activeSub?.tooltip ?? activeSub?.label ?? cell.tooltip ?? cell.label;
                  const displayIconClass = activeSub?.iconClass ?? cell.iconClass;
                  const displayToolType = activeSub?.type ?? cell.toolType;
                  const displayDisabled = activeSub?.disabled ?? cell.disabled;
                  const cellActive =
                    (cell.kind === "draw-tool" && displayToolType != null && drawToolType === displayToolType) ||
                    (cell.kind === "dimension" && drawToolType === "dimension") ||
                    (cell.kind === "constr" && constraintDialogOpen);
                  const subActive = cell.subTools?.some((s) => drawToolType === s.type) ?? false;
                  const isActive = cellActive || subActive;
                  const hasSub = !!cell.subTools && cell.subTools.length > 0;
                  const subDropdownId = `sketch-sub-${cell.key}`;
                  const subOpen = openDropdown === subDropdownId;
                  const handleCellClick = () => {
                    if (displayDisabled) return;
                    switch (cell.kind) {
                      case "draw-tool":
                        if (!displayToolType) return;
                        setDrawToolType(drawToolType === displayToolType ? "select" : displayToolType);
                        break;
                      case "dimension":
                        setDrawToolType(drawToolType === "dimension" ? "select" : "dimension");
                        break;
                      case "constr":
                        setConstraintDialogOpen(!constraintDialogOpen);
                        break;
                    }
                  };
                  const DisplayIcon = displayIcon;
                  return (
                    <div key={cell.key} className="input-toolbar__rib-wrap">
                      <button
                        type="button"
                        title={displayTooltip}
                        className={`rib-btn ${displayIconClass}${isActive ? " active" : ""}${hasSub ? " rib-btn--has-sub" : ""}`}
                        disabled={!!displayDisabled}
                        onClick={handleCellClick}
                      >
                        <DisplayIcon />
                        <span>{displayLabel}</span>
                      </button>
                      {hasSub && (
                        <button
                          type="button"
                          title={`${displayTooltip} options`}
                          className={`rib-btn__chevron${subOpen ? " active" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenDropdown((prev) => (prev === subDropdownId ? null : subDropdownId));
                          }}
                          aria-label={`${cell.label} options`}
                        >
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2,3 4,5 6,3" />
                          </svg>
                        </button>
                      )}
                      {subOpen && cell.subTools && (
                        <div className="input-toolbar__sub-menu">
                          {cell.subTools.map((sub) => {
                            const sActive = drawToolType === sub.type;
                            const sDisabled = !!sub.disabled;
                            const SubIcon = sub.icon;
                            return (
                              <button
                                key={sub.type}
                                type="button"
                                title={sub.tooltip ?? sub.label}
                                className={`rib-btn ${sub.iconClass}${sActive ? " active" : ""}`}
                                disabled={sDisabled}
                                onClick={() => {
                                  if (sDisabled) return;
                                  setDrawToolType(sActive ? "select" : sub.type);
                                  // 선택한 sub 도구가 cell 의 새 primary 가 됨.
                                  setGroupActiveTool((prev) => ({ ...prev, [cell.key]: sub }));
                                  setOpenDropdown(null);
                                }}
                              >
                                {SubIcon && <SubIcon />}
                                <span>{sub.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {onProjectEdges && (
                  <button
                    type="button"
                    title="Project 3D Edges"
                    className="rib-btn icon-project"
                    onClick={onProjectEdges}
                  >
                    <Icon.Project />
                    <span>Project</span>
                  </button>
                )}
                {onProjectSilhouette && (
                  <button
                    type="button"
                    title="Project 3D Silhouette Edges"
                    className="rib-btn icon-project"
                    onClick={onProjectSilhouette}
                  >
                    <Icon.Project />
                    <span>Silhouette</span>
                  </button>
                )}
                {onIntersect3D && (
                  <button
                    type="button"
                    title="Intersect 3D"
                    className="rib-btn icon-project"
                    onClick={onIntersect3D}
                  >
                    <Icon.IntersectionPoint />
                    <span>Intersect</span>
                  </button>
                )}
                {onInsertImage && (
                  <>
                    <label
                      title="Insert Image"
                      className="rib-btn icon-project"
                      htmlFor="input-insert-image"
                    >
                      <Icon.ImportImage />
                      <span>Image</span>
                    </label>
                    <input
                      id="input-insert-image"
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onInsertImage(f);
                        e.currentTarget.value = "";
                      }}
                    />
                  </>
                )}
              </div>
              <div className="input-toolbar__rib-group-title">Sketch</div>
            </div>
          </>
        )}

        {/* 3D 모드: Selection filter + Pad/Pocket/Revolve. html 시안 정합 (라벨 아래). */}
        {is3dMode && (
          <>
            <div className="input-toolbar__separator" />
            <button
              title="Pad"
              className={`tool-button tool-button--labeled icon-pad${canUse3dOps ? "" : " disabled"}`}
              onClick={() => selectedFaces.length > 0 && onStartPadPocket?.("pad", selectedFaces[0].planeKey)}
              disabled={!canUse3dOps}
              type="button"
            >
              <TbPad />
              <span className="tool-button__label">Pad</span>
            </button>
            <button
              title="Pocket"
              className={`tool-button tool-button--labeled icon-pocket${canUse3dOps ? "" : " disabled"}`}
              onClick={() => selectedFaces.length > 0 && onStartPadPocket?.("pocket", selectedFaces[0].planeKey)}
              disabled={!canUse3dOps}
              type="button"
            >
              <TbPocket />
              <span className="tool-button__label">Pocket</span>
            </button>
            <button
              title="Revolve"
              className={`tool-button tool-button--labeled icon-revolve${canUse3dOps ? "" : " disabled"}`}
              onClick={() => selectedFaces.length > 0 && onStartRevolve?.(selectedFaces[0].planeKey)}
              disabled={!canUse3dOps}
              type="button"
            >
              <TbRevolve />
              <span className="tool-button__label">Revolve</span>
            </button>

            <div className="input-toolbar__separator" />

            {/* Selection filter — 적당히 스타일 (사용자 요청). 라벨 = 현재 선택된 mode 의 표시명. */}
            <div className="input-toolbar__dropdown-wrapper input-toolbar__filter-group">
              {(() => {
                const TriggerIcon = SELECTION_FILTER_ICONS[selectionFilter];
                const isOpen = openDropdown === "selection-filter";
                return (
                  <button
                    type="button"
                    title={`Selection filter — ${SELECTION_FILTER_LABELS[selectionFilter]}`}
                    className="tool-button tool-button--labeled input-toolbar__filter-trigger"
                    onClick={() => toggleDropdown("selection-filter")}
                  >
                    <TriggerIcon className="input-toolbar__filter-icon" />
                    <span className="tool-button__label">{SELECTION_FILTER_LABELS[selectionFilter]}</span>
                    <span
                      aria-hidden
                      className={`input-toolbar__filter-arrow${isOpen ? " active" : ""}`}
                    />
                  </button>
                );
              })()}
              {openDropdown === "selection-filter" && (
                <div className="input-toolbar__dropdown-menu input-toolbar__dropdown-menu--labeled">
                  {SELECTION_FILTER_OPTIONS.map((mode) => {
                    const OptionIcon = SELECTION_FILTER_ICONS[mode];
                    return (
                      <button
                        key={mode}
                        type="button"
                        title={SELECTION_FILTER_LABELS[mode]}
                        className={`tool-button input-toolbar__filter-option${selectionFilter === mode ? " active" : ""}`}
                        onClick={() => {
                          setSelectionFilter(mode);
                          setOpenDropdown(null);
                        }}
                      >
                        <OptionIcon className="input-toolbar__filter-icon" />
                        <span className="input-toolbar__filter-option-label">{SELECTION_FILTER_LABELS[mode]}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default memo(SetupToolbar);
