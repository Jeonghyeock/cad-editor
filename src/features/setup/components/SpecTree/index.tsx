// Specification Tree — 범용 재귀 트리 구조
// 데이터를 TreeNodeData[]로 변환하여 TreeNodeComponent로 렌더

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextMenuItem } from "src/components/ContextMenu";
import Icon from "src/components/Icon";

import { contextMenuAtom } from "src/shared/stores/App.store";
import { fileIdAtom } from "src/shared/stores/File.store";
import { addToastAtom } from "src/shared/stores/Toast.store";

import { useHistoricalAtom } from "../../hooks/useHistoricalAtom";
import { ORIGIN_PLANE_KEYS } from "../../rendering/SketchPlaneManager";
import {
  canSetReferencePlanes,
  setupActiveSketchNameAtom,
  setupConstraintsAtom,
  setupDeletedBodiesAtom,
  setupHiddenOperationsAtom,
  setupHiddenShapeIdsAtom,
  setupHiddenSketchPortionsAtom,
  setup3DHoverAtom,
  setup3DSelectionAtom,
  setupModelsAtom,
  setupOperationsAtom,
  setupDefinitionShapeHoveredIdAtom,
  setupDefinitionShapeSelectedIdAtom,
  setupBakedSketchesAtom,
  setupReferencePlanesAtom,
  setupSketchConstraintListAtom,
  setupSketchGeometryListAtom,
  setupSketchHoveredItemAtom,
  setupSketchPlaneKeyAtom,
  setupSketchPlaneSelectionPendingAtom,
  setupSketchSelectedConstraintIdAtom,
  setupSketchSelectedIdsAtom,
  setupSketchShapeListAtom,
  setupViewModeAtom,
} from "../../Setup.store";
import type {
  ConstraintTreeEntry,
  OperationTreeEntry,
  SketchConstraintTreeItem,
  SketchGeometryTreeItem,
  SketchTreeEntry,
} from "../../Setup.type";

import type { TreeNodeData } from "./TreeNode";
import TreeNodeComponent from "./TreeNode";

const ORIGIN_PLANES = ["XY Plane", "YZ Plane", "ZX Plane"];

// 기하 타입별 아이콘 컴포넌트 매핑
function getGeometryTypeIcon(
  type: string,
): React.FunctionComponent | undefined {
  switch (type) {
    case "Line":
      return Icon.Line;
    case "Circle":
      return Icon.Circle;
    case "Arc":
      return Icon.Arc;
    case "Point":
      return Icon.Point;
    case "Curve":
      return Icon.Curve;
    case "Ellipse":
      return Icon.Ellipse;
    case "Polygon":
      return Icon.Rectangle;
    default:
      return undefined;
  }
}

// 구속조건 타입별 텍스트 접두사 (CATIA V5 스타일)
function getConstraintTypePrefix(type: string): string {
  switch (type) {
    case "Horizontal":
      return "H";
    case "Vertical":
      return "V";
    case "Parallel":
      return "∥";
    case "Perpendicular":
      return "⊥";
    case "Radius":
      return "R";
    case "Diameter":
      return "⌀";
    case "Coincidence":
      return "○";
    case "Tangent":
      return "⌒";
    case "Concentric":
      return "◎";
    case "Equal":
      return "=";
    case "Midpoint":
      return "M";
    case "Symmetric":
      return "⇌";
    case "Fix":
      return "⊙";
    case "Colinear":
      return "≡";
    case "Distance":
      return "↔";
    case "Angle":
      return "∠";
    case "Length":
      return "L";
    case "Point on Line":
      return "·L";
    case "Point on Circle":
      return "·○";
    case "Equal Radius":
      return "R=";
    case "Equidistant":
      return "⇔";
    case "Fix Together":
      return "⊕";
    default:
      return "";
  }
}

type SpecTreeProps = {
  onOriginPlaneHover?: (planeIndex: number | null) => void;
  onOriginPlanePick?: (planeIndex: number) => void;
  hiddenBodies?: Map<string, Set<number>>;
  hiddenModels?: Set<string>;
  sketchEntries?: SketchTreeEntry[];
  hoveredBody?: { modelId: string; bodyIndex: number } | null;
  selectedBody?: { modelId: string; bodyIndex: number } | null;
  selectedBodies?: { modelId: string; bodyIndex: number }[];
  onBodyVisibilityToggle?: (
    modelId: string,
    bodyIndex: number,
    isHidden: boolean,
  ) => void;
  onModelVisibilityToggle?: (modelId: string, isHidden: boolean) => void;
  onBodyHover?: (modelId: string, bodyIndex: number | null) => void;
  onModelContextMenu?: (e: React.MouseEvent, modelId: string) => void;
  onBodyContextMenu?: (
    e: React.MouseEvent,
    modelId: string,
    bodyIndex: number,
    isHidden: boolean,
  ) => void;
  onSketchContextMenu?: (e: React.MouseEvent, entry: SketchTreeEntry) => void;
  onSketchDoubleClick?: (entry: SketchTreeEntry) => void;
  onOperationContextMenu?: (
    e: React.MouseEvent,
    entry: OperationTreeEntry,
  ) => void;
  onOperationDoubleClick?: (entry: OperationTreeEntry) => void;
  onConstraintContextMenu?: (
    e: React.MouseEvent,
    entry: ConstraintTreeEntry,
  ) => void;
  onSketchGeometrySelect?: (geomId: string, ctrlKey?: boolean) => void;
  onSketchGeometryDelete?: (geomId: string) => void;
  onSketchGeometryToggleConstruction?: (geomId: string) => void;
  onSketchGeometryDoubleClick?: (geomId: string) => void;
  onSketchGeometryHover?: (geomId: string | null) => void;
  onSketchConstraintSelect?: (constraintId: string) => void;
  onSketchConstraintDoubleClick?: (constraintId: string) => void;
  onSketchConstraintDelete?: (constraintId: string) => void;
  onSketchConstraintAnimate?: (
    constraintId: string,
    currentValue: number,
  ) => void;
  onSketchConstraintHover?: (constraintId: string | null) => void;
  onSketchRigidGroupRename?: (constraintId: string, currentLabel: string | undefined) => void;
  onSketchRigidGroupDissolve?: (constraintId: string) => void;
  onModelSelect?: (modelId: string) => void;
  onModelHover?: (modelId: string | null) => void;
  onBodySelect?: (
    modelId: string,
    bodyIndex: number,
    ctrlKey?: boolean,
  ) => void;
};

const SpecTree = ({
  onOriginPlaneHover,
  onOriginPlanePick,
  hiddenBodies,
  hiddenModels,
  sketchEntries = [],
  hoveredBody,
  selectedBody,
  selectedBodies,
  onBodyVisibilityToggle,
  onModelVisibilityToggle,
  onBodyHover,
  onModelContextMenu,
  onBodyContextMenu,
  onSketchContextMenu,
  onSketchDoubleClick,
  onOperationContextMenu,
  onOperationDoubleClick,
  onConstraintContextMenu: _onConstraintContextMenu,
  onSketchGeometrySelect,
  onSketchGeometryDelete,
  onSketchGeometryToggleConstruction,
  onSketchGeometryDoubleClick,
  onSketchGeometryHover,
  onSketchConstraintSelect,
  onSketchConstraintDoubleClick,
  onSketchConstraintDelete,
  onSketchConstraintAnimate,
  onSketchConstraintHover,
  onSketchRigidGroupRename,
  onSketchRigidGroupDissolve,
  onModelSelect,
  onModelHover,
  onBodySelect,
}: SpecTreeProps) => {
  const models = useAtomValue(setupModelsAtom);
  const deletedBodies = useAtomValue(setupDeletedBodiesAtom);
  // 참조 평면 삭제도 통합 history 에 기록 — Ctrl+Z 로 지운 평면이 돌아오게. 그 평면을 스케치·연산이 쓰는 동안에는
  // 평면을 다시 지우는 redo 를 막는다 (canSetReferencePlanes).
  const [referencePlanes, setReferencePlanes] = useHistoricalAtom(setupReferencePlanesAtom, "referencePlanes", canSetReferencePlanes);
  const sketchPending = useAtomValue(setupSketchPlaneSelectionPendingAtom);
  const operations = useAtomValue(setupOperationsAtom);
  const _constraints = useAtomValue(setupConstraintsAtom);
  const viewMode = useAtomValue(setupViewModeAtom);
  const activeSketchName = useAtomValue(setupActiveSketchNameAtom);
  const geometryList = useAtomValue(setupSketchGeometryListAtom);
  const shapeList = useAtomValue(setupSketchShapeListAtom);
  // sketch 모드 외에서도 Definition top-level 그룹 표시 — bakedSketches 의 모든 sketch
  // shape 중 role !== null 인 것 union. sketch 모드 active 일 때는 shapeList 가 동일 정보를
  // live 로 sync 하므로 미사용.
  const bakedSketches = useAtomValue(setupBakedSketchesAtom);
  // Baked shape hover/select — SpecTree Definition entry ↔ 3D BakedShapeRenderer 양방향 SSOT.
  const bakedShapeHoveredId = useAtomValue(setupDefinitionShapeHoveredIdAtom);
  const bakedShapeSelectedId = useAtomValue(setupDefinitionShapeSelectedIdAtom);
  const setBakedShapeHoveredId = useSetAtom(setupDefinitionShapeHoveredIdAtom);
  const setBakedShapeSelectedId = useSetAtom(setupDefinitionShapeSelectedIdAtom);
  const constraintList = useAtomValue(setupSketchConstraintListAtom);
  const sketchSelectedIds = useAtomValue(setupSketchSelectedIdsAtom);
  const [sketchHoveredItem, setSketchHoveredItem] = useAtom(
    setupSketchHoveredItemAtom,
  );
  const sketchHoveredId =
    sketchHoveredItem?.kind === "geometry" ? sketchHoveredItem.geomId : null;
  const sketchHoveredConstraintId =
    sketchHoveredItem?.kind === "constraint"
      ? sketchHoveredItem.constraintId
      : null;
  const sketchSelectedConstraintId = useAtomValue(
    setupSketchSelectedConstraintIdAtom,
  );
  const setContextMenu = useSetAtom(contextMenuAtom);
  const addToast = useSetAtom(addToastAtom);
  const { t } = useTranslation();

  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  // visibility 는 per-file 영속 atom 으로 이동 — setupAtom.visibility 에서 derive.
  // visibility 토글도 ctrl+z 거치도록 history-aware setter 사용 (body/model 토글과 통일).
  // setupHiddenSketchesAtom 은 setup/index.tsx 의 BakedSketchManager sync 가 직접 사용
  // (그 atom 의 값이 BakedSketch group 전체 visibility 결정). SpecTree 안에서 사용 X —
  // sketch entry 의 visibility 토글은 toggleSketchPortionVisibility (portion only) 만.
  const [hiddenOperations, setHiddenOperations] = useHistoricalAtom(setupHiddenOperationsAtom, "hiddenOperations");
  const [hiddenShapeIds, setHiddenShapeIds] = useHistoricalAtom(setupHiddenShapeIdsAtom, "hiddenShapeIds");
  // hiddenSketchPortions — Sketch entry 의 visibility 토글이 'sketch portion' (role-less
  // geometry / 일반 shape) 만 hide. Shape (= definition portion = role 있는 shape face/
  // label) 은 sketch 토글에서 분리되어 별도 visibility 유지 (사용자 요청 — Sketch invisible
  // 토글이 그 sketch 의 모든 shape 까지 hide 시키지 않도록).
  const [hiddenSketchPortions, setHiddenSketchPortions] = useHistoricalAtom(setupHiddenSketchPortionsAtom, "hiddenSketchPortions");
  // 3D viewport 와 공유하는 hover/selection (양방향 sync — atom 이 source).
  // 2D `HoverItem` 처럼 단일 atom 의 discriminated union 으로 origin plane / ref plane / solid 모두 처리.
  const [viewportHover, setViewportHover] = useAtom(setup3DHoverAtom);
  const [viewportSelection, setViewportSelection] = useAtom(setup3DSelectionAtom);

  const toggleOperationVisibility = useCallback(
    (operationId: string) => {
      setHiddenOperations((prev) => {
        const next = new Set(prev);
        if (next.has(operationId)) next.delete(operationId);
        else next.add(operationId);
        return next;
      });
    },
    [setHiddenOperations],
  );

  // 파일 전환 시 hover local state reset (visibility / plane-selection 은 atom 이라 자동).
  const fileId = useAtomValue(fileIdAtom);
  useEffect(() => {
    setHoveredModelId(null);
  }, [fileId]);

  // origin plane 강조: (1) viewState.sketchPlaneKey (sketch 진입 plane) 또는
  // (2) setup3DSelectionAtom (3D / SpecTree 일반 선택). hover 는 atom 만.
  // setupAtom 전체 subscribe 대신 sketchPlaneKey 만 derive — setupAtom 의 다른 field
  // 변경 (select 시 다수 dispatch atom mutate) 마다 SpecTree 전체 re-render 발생하던
  // amplifier 차단. value 변경 시에만 invalidate.
  const sketchPlaneKey = useAtomValue(setupSketchPlaneKeyAtom);
  const selectedPlane = useMemo(() => {
    if (sketchPlaneKey) {
      const i = ORIGIN_PLANE_KEYS.indexOf(sketchPlaneKey);
      if (i >= 0) return i;
    }
    const found = viewportSelection.find((s) => s.kind === "originPlane");
    return found?.kind === "originPlane" ? found.index : null;
  }, [sketchPlaneKey, viewportSelection]);
  const hoveredPlane =
    viewportHover?.kind === "originPlane" ? viewportHover.index : null;
  const hoveredReferencePlaneId =
    viewportHover?.kind === "referencePlane" ? viewportHover.id : null;
  const selectedReferencePlaneId = useMemo(() => {
    const found = viewportSelection.find((s) => s.kind === "referencePlane");
    return found?.kind === "referencePlane" ? found.id : null;
  }, [viewportSelection]);
  const hoveredSolidId =
    viewportHover?.kind === "solid" ? viewportHover.operationId : null;
  const selectedSolidId = useMemo(() => {
    const found = viewportSelection.find((s) => s.kind === "solid");
    return found?.kind === "solid" ? found.operationId : null;
  }, [viewportSelection]);

  const handlePlaneClick = useCallback(
    (i: number) => {
      if (!sketchPending || !onOriginPlanePick) return;
      // selectedPlane 은 viewState 에서 derive — onOriginPlanePick → enterSketchMode 가
      // sketchPlaneKey 를 atom 에 쓰면 useMemo 가 자동 반영. 별도 set 불필요.
      onOriginPlanePick(i);
    },
    [sketchPending, onOriginPlanePick],
  );

  // toggleSketchVisibility (BakedSketch group 전체 toggle) 제거 — 088 새 구조에서
  // sketch entry 의 onVisibilityToggle 은 toggleSketchPortionVisibility (portion only)
  // 로 일원화. group 전체 visibility 가 필요하면 setupHiddenSketchesAtom 을 외부에서
  // 직접 mutate (setup/index.tsx 의 hiddenSketches watcher).

  const toggleShapeVisibility = useCallback(
    (shapeId: string) => {
      setHiddenShapeIds((prev) => {
        const next = new Set(prev);
        if (next.has(shapeId)) next.delete(shapeId);
        else next.add(shapeId);
        return next;
      });
    },
    [setHiddenShapeIds],
  );

  // Sketch entry visibility 토글 — sketch portion (role-less geometry / 일반 shape) 만
  // hide. role 있는 shape (Assembly 직속 또는 Op 자식) 은 영향 X. 086 의 BakedSketch
  // Manager 가 sketchGroup / definitionGroup 두 sub-group 분리 — 본 atom 은 sketchGroup
  // 만 toggle.
  const toggleSketchPortionVisibility = useCallback(
    (planeKey: string) => {
      setHiddenSketchPortions((prev) => {
        const next = new Set(prev);
        if (next.has(planeKey)) next.delete(planeKey);
        else next.add(planeKey);
        return next;
      });
    },
    [setHiddenSketchPortions],
  );

  const isSketchMode = viewMode === "2d-section";

  const selectedIdSet = useMemo(
    () => new Set(sketchSelectedIds),
    [sketchSelectedIds],
  );

  // 기하 항목 우클릭 컨텍스트 메뉴 빌드
  const buildGeometryContextMenu = useCallback(
    (e: React.MouseEvent, item: SketchGeometryTreeItem) => {
      e.preventDefault();
      // 참조 기하 (원점/축선)는 삭제/편집 불가
      if (item.isReference) return;

      // 우클릭 대상을 먼저 선택 + hover 플래그 리셋 (컨텍스트 메뉴가 mouseLeave를 차단)
      onSketchGeometrySelect?.(item.id);
      onSketchGeometryHover?.(null);

      const items: ContextMenuItem[] = [
        { type: "label", label: `${item.type}: ${item.label}` },
        { type: "separator" },
        {
          type: "item",
          label: item.isConstruction
            ? "Set as Standard"
            : "Set as Construction",
          onClick: () => onSketchGeometryToggleConstruction?.(item.id),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Delete",
          onClick: () => onSketchGeometryDelete?.(item.id),
        },
      ];
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items });
    },
    [
      onSketchGeometrySelect,
      onSketchGeometryHover,
      onSketchGeometryToggleConstruction,
      onSketchGeometryDelete,
      setContextMenu,
    ],
  );

  // 구속조건 항목 우클릭 컨텍스트 메뉴 빌드
  const buildConstraintContextMenu = useCallback(
    (e: React.MouseEvent, item: SketchConstraintTreeItem) => {
      e.preventDefault();

      // 우클릭 대상을 먼저 선택 + hover 플래그 리셋
      onSketchConstraintSelect?.(item.id);
      onSketchConstraintHover?.(null);

      const items: ContextMenuItem[] = [
        { type: "label", label: item.label },
        { type: "separator" },
      ];
      // 값이 있는 구속 (dimension)은 값 편집 + 애니메이션 메뉴 제공
      if (item.hasValue) {
        items.push({
          type: "item",
          label: "Edit Value",
          onClick: () => onSketchConstraintDoubleClick?.(item.id),
        });
        items.push({
          type: "item",
          label: "Animate",
          onClick: () => onSketchConstraintAnimate?.(item.id, item.value ?? 0),
        });
        items.push({ type: "separator" });
      }
      // Rigid Group (fix_together) 전용 메뉴: Rename / Dissolve
      if (item.rawType === "fix_together") {
        // item.label은 "Rigid Group: X" 또는 "Rigid Group1" 형식
        const currentLabel = item.label.startsWith("Rigid Group: ") ? item.label.slice("Rigid Group: ".length) : undefined;
        items.push({
          type: "item",
          label: "Rename Group",
          onClick: () => onSketchRigidGroupRename?.(item.id, currentLabel),
        });
        items.push({
          type: "item",
          label: "Dissolve Group",
          onClick: () => onSketchRigidGroupDissolve?.(item.id),
        });
        items.push({ type: "separator" });
      }
      items.push({
        type: "item",
        label: "Delete",
        onClick: () => onSketchConstraintDelete?.(item.id),
      });
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items });
    },
    [
      onSketchConstraintSelect,
      onSketchConstraintDoubleClick,
      onSketchConstraintDelete,
      onSketchConstraintAnimate,
      onSketchConstraintHover,
      onSketchRigidGroupRename,
      onSketchRigidGroupDissolve,
      setContextMenu,
    ],
  );

  // 활성 스케치 하위 트리 (Absolute Axis + Shapes + Geometry + Constraints)
  const activeSketchChildren = useMemo((): TreeNodeData[] => {
    if (!isSketchMode) return [];
    return [
      {
        id: "__axis__",
        label: "Absolute Axis",
        defaultExpanded: true,
        children: [
          {
            id: "__ref_origin__",
            label: "Origin",
            className: "input-spec-tree__item--ref",
            isHovered: sketchHoveredId === "__ref_origin__",
            isSelected: selectedIdSet.has("__ref_origin__"),
            onClick: (e?: React.MouseEvent) =>
              onSketchGeometrySelect?.(
                "__ref_origin__",
                e?.ctrlKey || e?.metaKey,
              ),
            onMouseEnter: () => {
              setSketchHoveredItem({
                kind: "geometry",
                geomId: "__ref_origin__",
              });
              onSketchGeometryHover?.("__ref_origin__");
            },
            onMouseLeave: () => {
              setSketchHoveredItem(null);
              onSketchGeometryHover?.(null);
            },
          },
          {
            id: "__ref_x_axis__",
            label: "H Direction",
            className: "input-spec-tree__item--ref",
            isHovered: sketchHoveredId === "__ref_x_axis__",
            isSelected: selectedIdSet.has("__ref_x_axis__"),
            onClick: (e?: React.MouseEvent) =>
              onSketchGeometrySelect?.(
                "__ref_x_axis__",
                e?.ctrlKey || e?.metaKey,
              ),
            onMouseEnter: () => {
              setSketchHoveredItem({
                kind: "geometry",
                geomId: "__ref_x_axis__",
              });
              onSketchGeometryHover?.("__ref_x_axis__");
            },
            onMouseLeave: () => {
              setSketchHoveredItem(null);
              onSketchGeometryHover?.(null);
            },
          },
          {
            id: "__ref_y_axis__",
            label: "V Direction",
            className: "input-spec-tree__item--ref",
            isHovered: sketchHoveredId === "__ref_y_axis__",
            isSelected: selectedIdSet.has("__ref_y_axis__"),
            onClick: (e?: React.MouseEvent) =>
              onSketchGeometrySelect?.(
                "__ref_y_axis__",
                e?.ctrlKey || e?.metaKey,
              ),
            onMouseEnter: () => {
              setSketchHoveredItem({
                kind: "geometry",
                geomId: "__ref_y_axis__",
              });
              onSketchGeometryHover?.("__ref_y_axis__");
            },
            onMouseLeave: () => {
              setSketchHoveredItem(null);
              onSketchGeometryHover?.(null);
            },
          },
        ],
      },
      // --- Shapes 섹션 (Geometry에서 분리). sketch 모드 안에선 모든 shape 표시,
      // role 있는 shape 는 label suffix [DA] / [GA] / [EE] 로 식별 + role 별 색.
      // 3D 모드로 나오면 별도 top-level Definition 그룹으로 분리 표시 (sketch 와 같은 레벨).
      {
        id: "__shapes__",
        label: "Shapes",
        badge: shapeList.length,
        defaultExpanded: true,
        children: (() => {
          if (shapeList.length === 0) {
            return [{ id: "__shape_empty__", label: "(empty)", className: "input-spec-tree__item--empty" }];
          }
          const geoItemMap = new Map<string, SketchGeometryTreeItem>();
          for (const item of geometryList) geoItemMap.set(item.id, item);

          const makeGeoNode = (item: SketchGeometryTreeItem): TreeNodeData => ({
            id: item.id,
            label: item.label,
            icon: getGeometryTypeIcon(item.type),
            isSelected: selectedIdSet.has(item.id),
            isHovered: sketchHoveredId === item.id,
            className: `input-spec-tree__item--geom${item.isConstruction ? " input-spec-tree__item--construction" : ""}`,
            onClick: (e?: React.MouseEvent) =>
              onSketchGeometrySelect?.(item.id, e?.ctrlKey || e?.metaKey),
            onMouseEnter: () => {
              setSketchHoveredItem({ kind: "geometry", geomId: item.id });
              onSketchGeometryHover?.(item.id);
            },
            onMouseLeave: () => {
              setSketchHoveredItem(null);
              onSketchGeometryHover?.(null);
            },
          });

          return shapeList.map((shape) => {
            const childNodes = shape.lineIds
              .map((lid) => geoItemMap.get(lid))
              .filter((g): g is SketchGeometryTreeItem => !!g)
              .map(makeGeoNode);
            // shape.label 은 본문 ('Shape N') 만, role suffix ('[DA]') + 색은
            // shape.labelSuffix 에 분리 — SpecTree 가 suffix span 만 inline color
            // 로 칠함. roleClass 는 더 이상 전체 라벨 색에 사용 X (제거).
            return {
              id: shape.id,
              label: shape.label,
              labelSuffix: shape.labelSuffix,
              badge: shape.lineIds.length,
              defaultExpanded: false,
              isSelected: selectedIdSet.has(shape.id),
              onClick: () => onSketchGeometrySelect?.(shape.id),
              onMouseEnter: () => {
                setSketchHoveredItem({ kind: "face", faceId: shape.id });
              },
              onMouseLeave: () => {
                setSketchHoveredItem(null);
              },
              children: childNodes,
            };
          });
        })(),
      },
      // --- Geometry 섹션 (shape에 소속되지 않은 독립 geometry만) ---
      {
        id: "__geometry__",
        label: "Geometry",
        badge: (() => {
          const shapeOwnedIds = new Set<string>();
          for (const shape of shapeList) for (const lid of shape.lineIds) shapeOwnedIds.add(lid);
          return geometryList.filter((g) => !shapeOwnedIds.has(g.id)).length;
        })(),
        defaultExpanded: true,
        children: (() => {
          const shapeOwnedIds = new Set<string>();
          for (const shape of shapeList) for (const lid of shape.lineIds) shapeOwnedIds.add(lid);
          const independent = geometryList.filter((g) => !shapeOwnedIds.has(g.id));

          if (independent.length === 0) {
            return [{ id: "__geo_empty__", label: "(empty)", className: "input-spec-tree__item--empty" }];
          }

          return independent.map((item) => ({
            id: item.id,
            label: item.label,
            icon: getGeometryTypeIcon(item.type),
            isSelected: selectedIdSet.has(item.id),
            isHovered: sketchHoveredId === item.id,
            className: `input-spec-tree__item--geom${item.isConstruction ? " input-spec-tree__item--construction" : ""}`,
            onClick: (e?: React.MouseEvent) =>
              onSketchGeometrySelect?.(item.id, e?.ctrlKey || e?.metaKey),
            onDoubleClick: () => onSketchGeometryDoubleClick?.(item.id),
            onContextMenu: item.isReference
              ? undefined
              : (e) => buildGeometryContextMenu(e, item),
            onMouseEnter: () => {
              setSketchHoveredItem({ kind: "geometry", geomId: item.id });
              onSketchGeometryHover?.(item.id);
            },
            onMouseLeave: () => {
              setSketchHoveredItem(null);
              onSketchGeometryHover?.(null);
            },
          }));
        })(),
      },
      {
        id: "__constraints__",
        label: "Constraints",
        badge: constraintList.length,
        defaultExpanded: false,
        children:
          constraintList.length === 0
            ? [
                {
                  id: "__cst_empty__",
                  label: "(empty)",
                  className: "input-spec-tree__item--empty",
                },
              ]
            : constraintList.map((item) => ({
                id: item.id,
                label: `${getConstraintTypePrefix(item.type)} ${item.label}`,
                isSelected: sketchSelectedConstraintId === item.id,
                isHovered: sketchHoveredConstraintId === item.id,
                className: "input-spec-tree__item--sketch-constraint",
                onClick: () => {
                  onSketchConstraintSelect?.(item.id);
                },
                onDoubleClick: item.hasValue
                  ? () => onSketchConstraintDoubleClick?.(item.id)
                  : undefined,
                onContextMenu: (e) => buildConstraintContextMenu(e, item),
                onMouseEnter: () => {
                  setSketchHoveredItem({
                    kind: "constraint",
                    constraintId: item.id,
                  });
                  onSketchConstraintHover?.(item.id);
                },
                onMouseLeave: () => {
                  setSketchHoveredItem(null);
                  onSketchConstraintHover?.(null);
                },
              })),
      },
      // Linkage 섹션은 top-level Linkage entry 로 분리됨 (linkageNode useMemo 참조).
      // 이전엔 sketch entry 안 sub-section 이라 sketch 모드일 때만 노출 — 사용자 흐름상
      // sketch ↔ 3D 모드 무관하게 항상 표시되는 게 자연스러워 PartBody 직속 entry 로 이동.
    ];
  }, [ // eslint-disable-line react-hooks/exhaustive-deps
    isSketchMode,
    geometryList,
    constraintList,
    selectedIdSet,
    sketchSelectedConstraintId,
    sketchHoveredConstraintId,
    sketchHoveredId,
    onSketchGeometrySelect,
    onSketchGeometryDoubleClick,
    onSketchGeometryHover,
    buildGeometryContextMenu,
    onSketchConstraintSelect,
    onSketchConstraintDoubleClick,
    onSketchConstraintHover,
    buildConstraintContextMenu,
    setSketchHoveredItem,
    shapeList,
  ]);

  // --- 섹션별 분리 memo: 독립 영역이 변경될 때만 해당 섹션만 재빌드 ---

  // 1) 기준 평면 노드 (XY / YZ / ZX)
  const planeNodes = useMemo(
    (): TreeNodeData[] =>
      ORIGIN_PLANES.map((label, i) => ({
        id: `origin-${i}`,
        label,
        isSelected: selectedPlane === i,
        isHovered: hoveredPlane === i,
        className: sketchPending
          ? "input-spec-tree__item--selectable"
          : undefined,
        onClick: () => {
          handlePlaneClick(i);
          // sketchPending 이 아닐 땐 plain select — viewport selection atom 에 반영.
          if (!sketchPending) {
            setViewportSelection([{ kind: "originPlane", index: i }]);
          }
        },
        onMouseEnter: () => {
          setViewportHover({ kind: "originPlane", index: i });
          onOriginPlaneHover?.(i);
        },
        onMouseLeave: () => {
          setViewportHover(null);
          onOriginPlaneHover?.(null);
        },
      })),
    [
      selectedPlane,
      hoveredPlane,
      sketchPending,
      handlePlaneClick,
      onOriginPlaneHover,
      setViewportHover,
      setViewportSelection,
    ],
  );

  // 2) Assembly 자식: 스케치 + Shape + Operations (linkage / models / obstacles 는 별도).
  // 사용자 요청 — PartBody wrap 제거, Sketch entry 는 active 시에만 axis/geom/constraints/
  // linkage 자식 표시 (inactive 면 leaf, 더블클릭으로 진입), 모든 Shape 는 Assembly 직속
  // (Operation 사용 shape 만 그 op 의 children 으로). "Shape N [role]" 라벨 유지.
  const partBodyChildren = useMemo((): TreeNodeData[] => {
    const children: TreeNodeData[] = [];

    // Shape 노드 빌더 공용 헬퍼.
    const buildShapeNode = (
      shape: NonNullable<typeof bakedSketches[string]>["shapes"][number],
      idx: number,
    ): TreeNodeData => {
      return {
        id: shape.id,
        label: `Shape ${idx + 1}`,
        badge: shape.lineIds.length,
        defaultExpanded: false,
        isSelected: bakedShapeSelectedId === shape.id,
        isHovered: bakedShapeHoveredId === shape.id,
        isHidden: hiddenShapeIds.has(shape.id),
        onClick: () => setBakedShapeSelectedId(shape.id),
        onMouseEnter: () => setBakedShapeHoveredId(shape.id),
        onMouseLeave: () => setBakedShapeHoveredId(null),
        onVisibilityToggle: () => toggleShapeVisibility(shape.id),
      };
    };

    // 모든 shape 수집 (sketch 별 정렬 후 인덱스). Operation 사용 shape id 합집합 후 free
    // shape 와 op-source shape 분리. active sketch (편집 중) 의 shape 는 sketch entry
    // 하위 'Shapes' 그룹에 이미 표시되어 있어 중복 방지 — free shape 에서 제외.
    type CollectedShape = {
      shape: NonNullable<typeof bakedSketches[string]>["shapes"][number];
      idx: number;
    };
    const collectedShapes: CollectedShape[] = [];
    const shapeById = new Map<string, CollectedShape>();
    const activeShapeIds = new Set<string>();
    const activeSketchEntry = isSketchMode
      ? sketchEntries.find((e) => e.planeName === activeSketchName)
      : undefined;
    for (const entry of sketchEntries) {
      const baked = bakedSketches[entry.planeKey];
      const isActiveEntry = entry === activeSketchEntry;
      (baked?.shapes ?? []).forEach((shape, idx) => {
        const collected = { shape, idx };
        collectedShapes.push(collected);
        shapeById.set(shape.id, collected);
        if (isActiveEntry) activeShapeIds.add(shape.id);
      });
    }

    // Sketch entries — active 시에만 자식 (activeSketchChildren). inactive 면 leaf.
    // Visibility 토글은 'sketch portion' 만 (role-less geometry / 일반 shape) — role 있는
    // shape (Assembly 직속 또는 Op 자식) 은 영향 X. 두 영역 분리 (사용자 요청).
    for (const entry of sketchEntries) {
      const isHidden = hiddenSketchPortions.has(entry.planeKey);
      const isActive = isSketchMode && entry.planeName === activeSketchName;
      children.push({
        id: `sketch-${entry.planeKey}`,
        label: entry.planeName,
        isSelected: isActive,
        isHidden,
        onVisibilityToggle: () => toggleSketchPortionVisibility(entry.planeKey),
        onContextMenu: (e) => {
          e.preventDefault();
          onSketchContextMenu?.(e, entry);
        },
        onDoubleClick: () => onSketchDoubleClick?.(entry),
        // active 시에만 axis/geom/constraints/linkage 자식, inactive 면 chevron 없는 leaf
        // (사용자 더블클릭으로 편집 진입 시점에 펼침).
        children: isActive ? activeSketchChildren : undefined,
        defaultExpanded: isActive,
      });
    }
    // 새 스케치 (bake 전)
    if (
      isSketchMode &&
      activeSketchName &&
      !sketchEntries.some((e) => e.planeName === activeSketchName)
    ) {
      children.push({
        id: "sketch-active-new",
        label: activeSketchName,
        isSelected: true,
        children: activeSketchChildren,
        defaultExpanded: true,
      });
    }

    // Operation 이 사용한 shape id 합집합 — free shape 에서 제외 (Pad 자식으로 옮김).
    const usedShapeIds = new Set<string>();
    for (const entry of operations) {
      const op = entry.operation;
      if ("profileIds" in op) {
        for (const id of op.profileIds) {
          if (shapeById.has(id)) usedShapeIds.add(id);
        }
      }
    }

    // Free shape (Operation 미사용 + active sketch 의 shape 도 아님) → sketch `Shapes [...]` 그룹.
    for (const entry of sketchEntries) {
      const freeShapes = collectedShapes.filter(
        (c) =>
          c.shape.planeKey === entry.planeKey
          && !usedShapeIds.has(c.shape.id)
          && !activeShapeIds.has(c.shape.id),
      );
      if (freeShapes.length === 0) continue;
      children.push({
        id: `sketch-shapes-${entry.planeKey}`,
        label: `Shapes [${entry.planeName}]`,
        badge: freeShapes.length,
        defaultExpanded: true,
        children: freeShapes.map((c) => buildShapeNode(c.shape, c.idx)),
      });
    }

    // op node builder — Pad/Pocket/Revolve. children = source Shape (profileIds 매핑).
    const buildOpNode = (entry: typeof operations[number]): TreeNodeData => {
      const isHidden = hiddenOperations.has(entry.operation.id);
      const opId = entry.operation.id;

      // source shape children — profileIds 매핑.
      const opSourceChildren: TreeNodeData[] = [];
      const op = entry.operation;
      if ("profileIds" in op) {
        for (const pid of op.profileIds) {
          const collected = shapeById.get(pid);
          if (collected) opSourceChildren.push(buildShapeNode(collected.shape, collected.idx));
        }
      }

      return {
        id: `op-${opId}`,
        label: entry.operation.type
          .replace(/-./g, (m) => " " + m[1].toUpperCase())
          .replace(/^./, (m) => m.toUpperCase()),
        info: `${entry.sketchPlaneName}${"depth" in entry.operation ? ` · ${entry.operation.depth}mm` : ""}${"angle" in entry.operation ? ` · ${entry.operation.angle}°` : ""}`,
        isHidden,
        isHovered: hoveredSolidId === opId,
        isSelected: selectedSolidId === opId,
        onVisibilityToggle: () => toggleOperationVisibility(opId),
        onContextMenu: (e) => {
          e.preventDefault();
          onOperationContextMenu?.(e, entry);
        },
        onDoubleClick: () => onOperationDoubleClick?.(entry),
        onClick: () => setViewportSelection([{ kind: "solid", operationId: opId }]),
        onMouseEnter: () => setViewportHover({ kind: "solid", operationId: opId }),
        onMouseLeave: () => setViewportHover(null),
        children: opSourceChildren.length > 0 ? opSourceChildren : undefined,
        defaultExpanded: false,
      };
    };

    // Operations — Assembly 직속 (Pad/Pocket/Revolve). op 이 사용한 source shape 는
    // 각 op node 의 children 으로 표시 (buildOpNode).
    for (const entry of operations) children.push(buildOpNode(entry));

    return children;
  }, [
    sketchEntries,
    hiddenSketchPortions,
    isSketchMode,
    activeSketchName,
    toggleSketchPortionVisibility,
    onSketchContextMenu,
    onSketchDoubleClick,
    activeSketchChildren,
    bakedSketches,
    bakedShapeHoveredId,
    bakedShapeSelectedId,
    setBakedShapeHoveredId,
    setBakedShapeSelectedId,
    hiddenShapeIds,
    toggleShapeVisibility,
    operations,
    hiddenOperations,
    toggleOperationVisibility,
    onOperationContextMenu,
    onOperationDoubleClick,
    hoveredSolidId,
    selectedSolidId,
    setViewportHover,
    setViewportSelection,
  ]);

  // 3) Imported Models (STEP)
  const modelNodes = useMemo((): TreeNodeData[] | null => {
    if (models.length === 0) return null;
    return models.map((m) => {
      const isModelHidden = hiddenModels?.has(m.id) ?? false;
      const modelHidden = hiddenBodies?.get(m.id);
      // 모델의 전체 body 선택 여부
      const allBodiesSelected =
        m.bodies.length > 0 &&
        m.bodies.every((_, idx) =>
          selectedBodies?.some(
            (b) => b.modelId === m.id && b.bodyIndex === idx,
          ),
        );
      return {
        id: `model-${m.id}`,
        label: m.fileName,
        isHidden: isModelHidden,
        isSelected: allBodiesSelected,
        isHovered: hoveredModelId === m.id,
        onClick: () => onModelSelect?.(m.id),
        onMouseEnter: () => {
          setHoveredModelId(m.id);
          onModelHover?.(m.id);
        },
        onMouseLeave: () => {
          setHoveredModelId(null);
          onModelHover?.(null);
        },
        onVisibilityToggle: () =>
          onModelVisibilityToggle?.(m.id, !isModelHidden),
        onContextMenu: (e) => {
          e.preventDefault();
          onModelContextMenu?.(e, m.id);
        },
        children: m.bodies.map((body, idx) => {
          const deletedSet = deletedBodies.get(m.id);
          if (deletedSet?.has(idx)) return null;
          const isHidden = modelHidden?.has(idx) ?? false;
          return {
            id: `body-${m.id}-${idx}`,
            label: body.name || `Body ${idx}`,
            isSelected:
              (selectedBody?.modelId === m.id &&
                selectedBody?.bodyIndex === idx) ||
              selectedBodies?.some(
                (b) => b.modelId === m.id && b.bodyIndex === idx,
              ),
            isHovered:
              (hoveredBody?.modelId === m.id &&
                hoveredBody?.bodyIndex === idx) ||
              hoveredModelId === m.id,
            isHidden,
            onClick: (e?: React.MouseEvent) =>
              onBodySelect?.(m.id, idx, e?.ctrlKey || e?.metaKey),
            onVisibilityToggle: () =>
              onBodyVisibilityToggle?.(m.id, idx, !isHidden),
            onMouseEnter: () => onBodyHover?.(m.id, idx),
            onMouseLeave: () => onBodyHover?.(m.id, null),
            onContextMenu: (e) => {
              e.preventDefault();
              onBodyContextMenu?.(e, m.id, idx, isHidden);
            },
          };
        }).filter(Boolean) as TreeNodeData[],
      };
    });
  }, [
    models,
    deletedBodies,
    hiddenBodies,
    hiddenModels,
    hoveredBody,
    hoveredModelId,
    selectedBody,
    selectedBodies,
    onBodyVisibilityToggle,
    onModelVisibilityToggle,
    onBodyHover,
    onModelSelect,
    onModelHover,
    onBodySelect,
    onModelContextMenu,
    onBodyContextMenu,
  ]);

  // 4) 최종 트리 조립 — 서브 memo들을 조합만 함 (가벼운 연산)
  const treeNodes = useMemo((): TreeNodeData[] => {
    // Reference Planes 자식 (사용자 정의 plane) — Global Standard Plane 바로 밑에 배치하기
    // 위해 미리 빌드.
    const referencePlaneChildren = referencePlanes.map((rp) => ({
      id: `refplane-${rp.id}`,
      label: rp.name,
      tooltip: rp.sourceDescription,
      isHovered: hoveredReferencePlaneId === rp.id,
      isSelected: selectedReferencePlaneId === rp.id,
      onClick: () => setViewportSelection([{ kind: "referencePlane" as const, id: rp.id }]),
      onMouseEnter: () => setViewportHover({ kind: "referencePlane" as const, id: rp.id }),
      onMouseLeave: () => setViewportHover(null),
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({
          visible: true,
          items: [
            {
              type: "item" as const,
              label: "Delete",
              onClick: () => {
                // 그 평면을 쓰는 스케치·연산이 있으면 setter 가 지우지 않는다 (삭제 undo 뒤 redo 를 막는 것과 같은
                // canSetReferencePlanes 판정) — 아무 일 없이 끝나지 않게 이유를 알린다.
                if (!setReferencePlanes((prev) => prev.filter((p) => p.id !== rp.id))) {
                  addToast({ type: "info", message: t("toast.referencePlaneInUse", { name: rp.name }) });
                }
              },
            },
          ],
          x: e.clientX,
          y: e.clientY,
        });
      },
    }));

    const partChildren: TreeNodeData[] = [
      // Global Standard Plane group — XY / YZ / ZX 묶어서 한 그룹 (목업 정합).
      {
        id: "global-standard-planes",
        label: "Global Standard Plane",
        defaultExpanded: true,
        children: planeNodes,
      },
      // Reference Planes — Global Standard Plane 바로 밑에 배치 (사용자 요청).
      ...(referencePlaneChildren.length > 0
        ? [{
            id: "reference-planes",
            label: "Reference Planes",
            badge: referencePlaneChildren.length,
            defaultExpanded: true,
            children: referencePlaneChildren,
          }]
        : []),
      // PartBody wrap 제거 — sketches / shapes / operations 가 Assembly 직속 (사용자 요청).
      ...partBodyChildren,
    ];

    if (modelNodes) {
      partChildren.push({
        id: "imported-models",
        label: "External References",
        defaultExpanded: true,
        children: modelNodes,
      });
    }

    // (Reference Planes 는 partChildren 초기 배열에서 Global Standard Plane 바로 밑에 배치됨.)

    // 빈 그룹 placeholder — children: [] 인 그룹에 '(empty)' leaf 를 자동 삽입. caller 쪽에서
    // conditional push 가 아닌 항상-push 정책의 그룹은 비어있을 때 chevron+포인터 시각이
    // 무의미 → '(empty)' 표시.
    const ensureEmptyPlaceholders = (nodes: TreeNodeData[]): void => {
      for (const node of nodes) {
        if (!node.children) continue;
        if (node.children.length === 0) {
          node.children = [{
            id: `${node.id}-empty`,
            label: "(empty)",
            className: "input-spec-tree__item--empty",
          }];
        } else {
          ensureEmptyPlaceholders(node.children);
        }
      }
    };
    ensureEmptyPlaceholders(partChildren);

    return [
      {
        id: "part-root",
        label: "Assembly",
        defaultExpanded: true,
        className: "input-spec-tree__group-header--root",
        children: partChildren,
      },
    ];
  }, [ // eslint-disable-line react-hooks/exhaustive-deps
    planeNodes,
    referencePlanes,
    partBodyChildren,
    modelNodes,
    setContextMenu,
    setReferencePlanes,
    addToast,
    t,
    hoveredReferencePlaneId,
    selectedReferencePlaneId,
    setViewportHover,
    setViewportSelection,
  ]);

  return (
    <div className="input-spec-tree">
      {treeNodes.map((node) => (
        <TreeNodeComponent key={node.id} node={node} />
      ))}
    </div>
  );
};

export default memo(SpecTree);
