// Input 피처 3D 캔버스 뷰포트
// STEP 모델 + face 직접 선택 + 스케치 모드 (Three.js 링키지 오버레이)

import { type Atom, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type { ContextMenuItem } from "src/components/ContextMenu";

import { HIT_BUFFER } from "src/shared/constants/CanvasConstants";
import { contextMenuAtom } from "src/shared/stores/App.store";
import { fileDataAtomFamily, fileIdAtom } from "src/shared/stores/File.store";

import type { GlobalHistoryManager } from "../../core/GlobalHistoryManager";
import type { PlanePickHit, ViewportHover } from "../../hooks/use3DPickHandler";
import { useCrossSectionMode } from "../../hooks/useCrossSectionMode";
import { useInputGeometryStore } from "../../hooks/useInputGeometryStore";
import { computeEngineScale, useInputSceneController } from "../../hooks/useInputSceneController";
import { useSketchKeyboardHandler } from "../../hooks/useSketchKeyboardHandler";
import { useSketchRefCallbacks } from "../../hooks/useSketchRefCallbacks";
import type SetupScene from "../../rendering/SetupScene";
import { enterSketchModeAtom, exitSketchModeAtom, type GeometryStoreBundle, setup3DSelectionAtom, setupActiveSketchNameAtom, setupDefinitionShapeHoveredIdAtom, setupDefinitionShapeSelectedIdAtom, setupBakedSketchesAtom, setupChamferModeAtom, setupChamferDistanceAtom, setupChamferDistance2Atom, setupConstraintApplicabilityAtom, setupAppliedConstraintTypesAtom, setupConstraintSolveStatusAtom, setupConstraintVisibilityFilterAtom, setupConstraintVisibleAtom, setupDeletedBodiesAtom, setupDimensionModeAtom, setupDrawToolAtom, setupFilletModeAtom, setupFilletRadiusAtom, setupHiddenBodiesAtom, setupModelsAtom, setupOffsetDistanceAtom, setupOffsetModeAtom, setupOperationsAtom, setupPendingRestoreAtom, setupReferencePlanesAtom, setupRefPlaneModeAtom, setupRefPlanePreviewAtom, setupSelectionInfoAtom, setupSketchConstraintListAtom, setupSketchEntriesAtom, setupSketchGeometryListAtom, setupSketchHoveredItemAtom, setupSketchPlaneSelectionPendingAtom, setupSketchPlaneAtom, setupSketchSelectedConstraintIdAtom, setupSketchSelectedIdsAtom, setupSketchShapeListAtom, setupUndoFlashIdsAtom, setupViewModeAtom } from "../../Setup.store";
import type { CrossSectionDef, OperationTreeEntry, SelectionPropertyInfo, SerializedGeometry, SerializedSketch, SketchConstraintTreeItem, SketchDrawToolType, SketchGeometryTreeItem, SketchPlane, SketchShapeTreeItem, SketchTreeEntry } from "../../Setup.type";
import type { ConstraintApplicability, DimensionConstraintType } from "../../sketch/constraints/ConstraintValidator";
import { getAppliedConstraintTypes, getConstraintApplicability } from "../../sketch/constraints/ConstraintValidator";
import { addDrivenDimension } from "../../sketch/constraints/drivenDimension";
import type { SketchConstraint } from "../../sketch/constraints/SketchConstraint.type";
import type { SketchConstraintStore } from "../../sketch/constraints/SketchConstraintStore";
import { computeDependencyHighlight } from "../../sketch/DependencyGraph";
import { orderLineIdsByCoincidence } from "../../sketch/shapeDetector";
import { isReferenceId, REF_ORIGIN_ID, REF_X_AXIS_ID, REF_Y_AXIS_ID, type SketchGeometryStore } from "../../sketch/SketchGeometryStore";
import { clearClosedSketch, startBlankSketch } from "../../sketch/sketchStoreReset";
import { DimensionDrawTool } from "../../sketch/tools/DimensionDrawTool";
import type { DrawTool } from "../../sketch/tools/DrawTool";
import "../../sketch/tools/registerAllTools";
import { toolRegistry } from "../../sketch/tools/ToolRegistry";
import { omitUndefined } from "../../utils/objectUtils";
import { deserializeSetupData } from "../../utils/serialization";

import PreSelectionNavigator from "../PreSelectionNavigator";


type SketchBakedInfo = {
  planeKey: string;
  planeName: string;
  plane: SketchPlane;
};

type SetupCanvasProps = {
  closeSketchRef: React.RefObject<(() => void) | null>;
  /**
   * 현재 sketch 모드의 live 데이터를 baked Map 으로 저장만 — engine/geoStore 정리, viewMode
   * 전환 등 부수 효과 없음. 페이지/파일 이동 직전 또는 saveFile 직전 호출해 데이터 보존.
   */
  bakeCurrentSketchRef?: React.RefObject<(() => void) | null>;
  /**
   * 3D 모드에서 preset 적용 시 호출 — 현재 engine/geoStore 데이터를 origin XY plane
   * sketch entry 로 baking. sketch mode 진입 없이 entry 만 생성 + SpecTree 표시.
   */
  bakeOriginXYRef?: React.RefObject<(() => void) | null>;
  pickOriginPlaneRef: React.RefObject<((planeIndex: number) => void) | null>;
  enterSketchByKeyRef?: React.RefObject<((planeKey: string, planeName: string, options?: { skipAnimation?: boolean }) => void) | null>;
  sceneRef?: React.RefObject<SetupScene | null>;
  onSketchBaked?: (info: SketchBakedInfo) => void;
  onModelContextMenu?: (e: React.MouseEvent, modelId: string, bodyIndex?: number) => void;
  /** 3D viewport 통합 hover (origin plane / ref plane / extruded solid). null = none. */
  onViewportHover?: (hit: ViewportHover | null) => void;
  /** 3D viewport 통합 select. null = clear. */
  onViewportSelect?: (hit: ViewportHover | null) => void;
  onBakedSketchFacePick?: (planeKey: string, planeName: string) => void;
  onExtrudedSolidPick?: (operationId: string) => void;
  onBakedSketchFaceSelect?: (planeKey: string | null, planeName: string | null, profileId?: string | null, additive?: boolean) => void;
  onDeleteSelectedBodies?: () => void;
  onDeleteSelectedOperation?: () => void;
  globalHistory?: GlobalHistoryManager;
  getOperations?: () => OperationTreeEntry[];
  /** SpecTree에서 기하/구속에 hover 중이면 true — 캔버스 hover 업데이트 방지 */
  sketchTreeHoveringRef?: React.RefObject<boolean>;
  /** Over-constrained dimension → driven dimension 확인 프롬프트 콜백 */
  onDrivenDimensionPrompt?: (constraint: SketchConstraint, callback: (asReference: boolean) => void) => void;
  /**
   * geometry bundle atom override — default `setupGeometryStoreBundleAtom`. Result 페이지
   * 가 `resultGeometryStoreBundleAtom` 전달 시 별도 sketch geo bundle 사용.
   */
  geometryBundleAtom?: Atom<GeometryStoreBundle>;
  /**
   * Scene 이 SetupCanvas 안에서 새로 생성되어 sceneRef.current 가 채워진 시점에 호출.
   * sceneRef 의존 초기화 (mesh build / 렌더 트리거 등) 를 mount race 없이 수행하기 위한 훅.
   */
  onSceneReady?: (scene: SetupScene) => void;
  children?: React.ReactNode;
};

const _PLANE_NAMES = ["XY Plane", "YZ Plane", "ZX Plane"];

// 참조 기하 ID → 표시 이름 매핑
const REF_NAMES: Record<string, string> = {
  [REF_ORIGIN_ID]: "Origin",
  [REF_X_AXIS_ID]: "X Axis",
  [REF_Y_AXIS_ID]: "Y Axis",
};

// 선택된 기하의 속성 정보 계산
const computeSelectionInfo = (store: SketchGeometryStore): SelectionPropertyInfo | null => {
  const sel = store.selection;
  if (sel.length === 0) return null;

  if (sel.length > 1) {
    return { type: "multi", count: sel.length };
  }

  const item = sel[0];

  // face(shape) 선택
  if (item.kind === "face") {
    const shape = store.shapes.find((s) => s.id === item.faceId)
      ?? store.shapes.flatMap((s) => s.holes).find((h) => h.id === item.faceId);
    if (shape) {
      const area = Math.abs(shape.vertices.reduce((s, v, i) => {
        const n = shape.vertices[(i + 1) % shape.vertices.length];
        return s + v.x * n.y - n.x * v.y;
      }, 0) / 2);
      return { type: "shape", shapeId: shape.id, area, edgeCount: shape.lineIds.length };
    }
    return null;
  }

  // vertex 선택
  if (item.kind === "vertex") {
    return { type: "point", x: item.x, y: item.y };
  }

  // geometry 선택
  const id = item.geomId;

  // 참조 기하(원점/축선)는 전용 표시
  const refName = REF_NAMES[id];
  if (refName) {
    return { type: "reference", name: refName };
  }

  const geom = store.geometries.get(id);
  if (!geom) return null;

  switch (geom.type) {
    case "point":
      return { type: "point", x: geom.x, y: geom.y };
    case "line": {
      const length = Math.hypot(geom.x2 - geom.x1, geom.y2 - geom.y1);
      const angle = Math.atan2(geom.y2 - geom.y1, geom.x2 - geom.x1) * (180 / Math.PI);
      return { type: "line", x1: geom.x1, y1: geom.y1, x2: geom.x2, y2: geom.y2, length, angle };
    }
    case "circle":
      return { type: "circle", cx: geom.cx, cy: geom.cy, r: geom.r };
    case "arc": {
      let sweep = (geom.endAngle - geom.startAngle) * (180 / Math.PI);
      if (sweep <= 0) sweep += 360;
      return { type: "arc", cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: geom.startAngle, endAngle: geom.endAngle, sweep };
    }
    case "curve":
      return { type: "curve", controlPointCount: geom.points.length };
    case "ellipse":
      return { type: "ellipse", cx: geom.cx, cy: geom.cy, rx: geom.rx, ry: geom.ry };
    case "polygon":
      return { type: "polygon", vertexCount: geom.vertices.length };
    default:
      return null;
  }
};

// 도구 타입별 DrawTool 인스턴스 맵 생성
const createDrawToolMap = (): Map<SketchDrawToolType, DrawTool> => toolRegistry.createAll();

// SpecTree 스케치 모드: 기하 목록 생성 (타입별 넘버링)
const buildSketchGeometryList = (geoStore: SketchGeometryStore): SketchGeometryTreeItem[] => {
  const typeCounters = new Map<string, number>();
  const items: SketchGeometryTreeItem[] = [];

  for (const [id, geom] of geoStore.geometries) {
    // 참조 기하는 Absolute Axis 그룹에서 표시하므로 제외
    if (isReferenceId(id)) continue;
    // polygon은 시각적으로 구성 line들이 이미 등록되므로 스킵
    if (geom.type === "polygon") continue;

    const typeName = geom.type.charAt(0).toUpperCase() + geom.type.slice(1);
    const count = (typeCounters.get(typeName) ?? 0) + 1;
    typeCounters.set(typeName, count);

    items.push({
      id,
      type: typeName,
      label: `${typeName}${count}`,
      isConstruction: "isConstruction" in geom ? geom.isConstruction : false,
      isReference: false,
    });
  }
  return items;
};

// SpecTree 스케치 모드: 구속조건 목록 생성 (타입별 넘버링)
const CONSTRAINT_TYPE_LABELS: Record<string, string> = {
  coincident: "Coincidence",
  horizontal: "Horizontal",
  vertical: "Vertical",
  fix: "Fix",
  distance: "Distance",
  equal: "Equal",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
  midpoint: "Midpoint",
  point_on_line: "Point On Line",
  concentric: "Concentric",
  colinear: "Colinear",
  point_on_circle: "Point On Circle",
  radius: "Radius",
  diameter: "Diameter",
  equal_radius: "Equal Radius",
  line_length: "Length",
  angle: "Angle",
  point_line_distance: "Point Line Distance",
  symmetric: "Symmetry",
  horizontal_distance: "H Distance",
  vertical_distance: "V Distance",
  line_angle: "Line Angle",
  equidistant: "Equidistant",
  fix_together: "Rigid Group",
};

const buildSketchConstraintList = (constraintStore: SketchConstraintStore): SketchConstraintTreeItem[] => {
  const typeCounters = new Map<string, number>();
  const items: SketchConstraintTreeItem[] = [];

  for (const [, c] of constraintStore.constraints) {
    const typeLabel = CONSTRAINT_TYPE_LABELS[c.type] ?? c.type;
    const count = (typeCounters.get(typeLabel) ?? 0) + 1;
    typeCounters.set(typeLabel, count);

    const hasValue = "value" in c && c.value != null;
    const value = hasValue ? (c as { value: number }).value : undefined;
    const valueStr = hasValue ? ` = ${Math.round(value! * 100) / 100}` : "";

    // Rigid Group(fix_together)은 사용자 지정 label을 우선 표시
    let displayLabel = `${typeLabel}${count}${valueStr}`;
    if (c.type === "fix_together" && c.label) {
      displayLabel = `${typeLabel}: ${c.label}`;
    }

    items.push({
      id: c.id,
      type: typeLabel,
      rawType: c.type,
      label: displayLabel,
      hasValue,
      value,
    });
  }
  return items;
};

const SetupCanvas = ({ closeSketchRef, bakeCurrentSketchRef, bakeOriginXYRef, pickOriginPlaneRef, enterSketchByKeyRef, sceneRef: externalSceneRef, onSketchBaked, onModelContextMenu, onBakedSketchFacePick, onExtrudedSolidPick, onBakedSketchFaceSelect, onDeleteSelectedBodies, onDeleteSelectedOperation, globalHistory, getOperations, sketchTreeHoveringRef, onDrivenDimensionPrompt, onViewportHover, onViewportSelect, geometryBundleAtom, onSceneReady, children }: SetupCanvasProps) => {
  const models = useAtomValue(setupModelsAtom);
  const sketchEntries = useAtomValue(setupSketchEntriesAtom);
  const viewMode = useAtomValue(setupViewModeAtom);
  const drawToolType = useAtomValue(setupDrawToolAtom);
  const setDrawToolType = useSetAtom(setupDrawToolAtom);
  // BakedShape hover/select SSOT — 3D viewport / SpecTree 양방향 동기.
  const setBakedShapeHoveredId = useSetAtom(setupDefinitionShapeHoveredIdAtom);
  const setBakedShapeSelectedId = useSetAtom(setupDefinitionShapeSelectedIdAtom);
  const refPlanePreview = useAtomValue(setupRefPlanePreviewAtom);
  // PlaneDefinitionPanel 의 실시간 preview → 3D scene 의 wireframe 으로 반영
  useEffect(() => {
    sceneRef.current?.setRefPlanePreview(refPlanePreview);
  }, [refPlanePreview]);
  const sketchPending = useAtomValue(setupSketchPlaneSelectionPendingAtom);
  const setSketchPending = useSetAtom(setupSketchPlaneSelectionPendingAtom);
  const setSketchPlane = useSetAtom(setupSketchPlaneAtom);
  const enterSketchMode = useSetAtom(enterSketchModeAtom);
  const exitSketchMode = useSetAtom(exitSketchModeAtom);
  const setContextMenu = useSetAtom(contextMenuAtom);
  const setConstraintApplicability = useSetAtom(setupConstraintApplicabilityAtom);
  const setConstraintApplied = useSetAtom(setupAppliedConstraintTypesAtom);
  const setConstraintSolveStatus = useSetAtom(setupConstraintSolveStatusAtom);
  const setDimensionMode = useSetAtom(setupDimensionModeAtom);
  const setFilletMode = useSetAtom(setupFilletModeAtom);
  const filletRadius = useAtomValue(setupFilletRadiusAtom);
  const setFilletRadius = useSetAtom(setupFilletRadiusAtom);
  const setChamferMode = useSetAtom(setupChamferModeAtom);
  const chamferDistance = useAtomValue(setupChamferDistanceAtom);
  const setChamferDistance = useSetAtom(setupChamferDistanceAtom);
  const chamferDistance2 = useAtomValue(setupChamferDistance2Atom);
  const setChamferDistance2 = useSetAtom(setupChamferDistance2Atom);
  const setOffsetMode = useSetAtom(setupOffsetModeAtom);
  const offsetDistance = useAtomValue(setupOffsetDistanceAtom);
  const setOffsetDistance = useSetAtom(setupOffsetDistanceAtom);
  const setSelectionInfo = useSetAtom(setupSelectionInfoAtom);
  const setActiveSketchName = useSetAtom(setupActiveSketchNameAtom);
  const setSketchGeometryList = useSetAtom(setupSketchGeometryListAtom);
  const setSketchShapeList = useSetAtom(setupSketchShapeListAtom);
  const setSketchConstraintList = useSetAtom(setupSketchConstraintListAtom);
  const setSketchSelectedIds = useSetAtom(setupSketchSelectedIdsAtom);
  const constraintVisible = useAtomValue(setupConstraintVisibleAtom);
  const constraintFilter = useAtomValue(setupConstraintVisibilityFilterAtom);
  const undoFlashIds = useAtomValue(setupUndoFlashIdsAtom);
  const [sketchHoveredItem, setSketchHoveredItem] = useAtom(setupSketchHoveredItemAtom);
  const setSketchSelectedConstraintId = useSetAtom(setupSketchSelectedConstraintIdAtom);

  // SpecTree hover → 기하 store hoveredItem 동기화
  useEffect(() => {
    const geoStore = geometryStoreRef.current;
    geoStore.hoveredItem = sketchHoveredItem;
    geoStore.requestRender();
  }, [sketchHoveredItem]);

  // GeometryStore (기하 프리미티브 전용)
  const { store: geometryStore, constraintStore } = useInputGeometryStore(geometryBundleAtom);
  const geometryStoreRef = useRef(geometryStore);
  geometryStoreRef.current = geometryStore;

  const constraintStoreRef = useRef(constraintStore);
  constraintStoreRef.current = constraintStore;

  // 클립보드 (복사/붙여넣기용)
  const clipboardRef = useRef<SerializedGeometry[]>([]);
  const pasteCountRef = useRef(0);

  // DrawTool 인스턴스 맵
  const drawToolMap = useMemo(() => createDrawToolMap(), []);
  const activeDrawTool = drawToolType !== "select" ? drawToolMap.get(drawToolType) ?? null : null;
  const activeDrawToolRef = useRef<DrawTool | null>(null);
  activeDrawToolRef.current = activeDrawTool;

  // DimensionDrawTool: 배치 완료 시 값 편집 팝업 트리거
  const dimensionTool = drawToolMap.get("dimension");
  if (dimensionTool instanceof DimensionDrawTool) {
    dimensionTool.onPlaced = (_result) => {
      // 첫 dimension 배치는 default 값으로 즉시 constraint 추가 + 선택만 (panel 안 뜸).
      // 사용자가 값을 바꾸려면 dimension constraint 더블클릭 → handleDoubleClick 이 panel 열음.
      const gStore = geometryStoreRef.current;
      const cStore = gStore.constraintStore;
      if (cStore) {
        let lastId: string | null = null;
        for (const id of cStore.constraints.keys()) lastId = id;
        if (lastId) gStore.selectedConstraintId = lastId;
      }
    };
    // Over-constrained → driven dimension 프롬프트
    dimensionTool.onOverConstrained = (constraint) => {
      if (onDrivenDimensionPrompt) {
        onDrivenDimensionPrompt(constraint, (asReference) => {
          const gStore = geometryStoreRef.current;
          if (asReference) {
            // driven dimension으로 추가 + 선택. 값 패널은 열지 않음 — 참조 치수의 값은 라벨이 현재
            // 기하에서 계산하고, 열면 OK 가 남아 있던 선택 (직전에 배치한 치수) 을 패널 값으로 바꿨다.
            addDrivenDimension(gStore, constraint, () => setDimensionMode(null));
          }
          gStore.requestRender();
        });
      }
    };
  }

  const store = useStore();
  const sceneRef = useRef<SetupScene | null>(null);
  const getDrawTool = useCallback(() => activeDrawToolRef.current, []);
  const getGeometryStore = useCallback(() => geometryStoreRef.current, []);

  // 글로벌 히스토리 ↔ 기하 스토어 연동
  useEffect(() => {
    if (!globalHistory) return;
    globalHistory.setGeometryStore(geometryStore);
    // 기하 스토어에 글로벌 히스토리 참조 설정 (단일 진실 원천)
    geometryStore.globalHistory = globalHistory;
    return () => {
      geometryStore.globalHistory = null;
      globalHistory.clearSubSystems();
    };
  }, [globalHistory, geometryStore]);

  // 현재 스케치 평면 추적 (bake 시 사용)
  const currentPlaneRef = useRef<SketchPlane | null>(null);
  const currentPlaneNameRef = useRef("");
  const sketchCounterRef = useRef(0);

  // 외부 스냅 기하 캐시 (STEP face 에지 등)
  const externalSnapGeomsRef = useRef<SerializedGeometry[]>([]);

  // 직렬화된 스케치 → 기하 스토어 복원 (geometry → constraint → shape 순).
  const restoreSketch = useCallback((data: SerializedSketch) => {
    // 1) 기하 프리미티브 복원 — sketch 가 단일 진실.
    const geoStore = geometryStoreRef.current;
    if (data.geometries && data.geometries.length > 0) {
      geoStore.deserialize(data.geometries);
    } else {
      geoStore.clear();
    }

    // 2) 구속조건 복원
    const cStore = constraintStoreRef.current;
    if (data.constraints && data.constraints.length > 0) {
      cStore.deserialize(data.constraints);
    } else {
      cStore.clear();
    }

    // 3) shapes 복원. lineIds 를 chain 순서로 재정렬 (구 버전 .mth 호환).
    if (data.shapes && data.shapes.length > 0) {
      geoStore.shapes = data.shapes.map((sh) => {
        const reordered = orderLineIdsByCoincidence(sh.lineIds, geoStore.geometries, cStore.constraints);
        return { ...sh, lineIds: reordered, holes: [] } as SerializedSketch["shapes"][number];
      });
      geoStore.markShapesChanged();
    }

    // 4) 원점/축선 참조 기하 주입
    geoStore.injectReferenceGeometry();
    geoStore.requestRender();
  }, []);

  const getExternalSnapGeometries = useCallback(() => externalSnapGeomsRef.current, []);

  // face 클릭 → 단면 즉시 적용
  const getScene = useCallback(() => sceneRef.current, []);
  const { applyCrossSection, extractFacePlane } = useCrossSectionMode({ getScene });

  const handleFacePick = useCallback(
    (result: { modelId: string; faceGroupId: number }) => {
      // Reference Plane 생성 모드: face를 기준 평면으로 선택 (sketch 부작용 없이 plane 정보만)
      const refMode = store.get(setupRefPlaneModeAtom);
      if (refMode?.step === "select-plane") {
        const crossSection: CrossSectionDef = { type: "face", faceGroupId: result.faceGroupId };
        const facePlane = extractFacePlane(result.modelId, crossSection);
        if (facePlane) {
          store.set(setupRefPlaneModeAtom, {
            step: "select-plane",
            selectionMode: "face",
            basePlane: facePlane,
            basePlaneName: `Face #${result.faceGroupId}`,
          });
        }
        return;
      }

      const crossSection: CrossSectionDef = { type: "face", faceGroupId: result.faceGroupId };

      const plane = applyCrossSection(result.modelId, crossSection);
      if (plane) {
        currentPlaneRef.current = plane;

        const s = sceneRef.current;
        const planeKey = s?.getPlaneKey(plane);

        // 기존 저장된 스케치가 있으면 이름 유지 + 엔진 복원
        const saved = s?.getSavedSketch(plane);
        if (saved && s) {
          const existing = sketchEntries.find((e) => e.planeKey === planeKey);
          currentPlaneNameRef.current = existing?.planeName ?? `Sketch ${sketchCounterRef.current + 1}`;
          restoreSketch(saved);
          s.removeBakedSketch(plane);
        } else {
          // 새 스케치: 자동 번호 이름 부여 + 이전 스케치 잔여물 없이 참조 기하만 주입 (카메라 전환 완료 후)
          sketchCounterRef.current += 1;
          currentPlaneNameRef.current = `Sketch ${sketchCounterRef.current}`;
          startBlankSketch(geometryStoreRef.current, constraintStoreRef.current);
        }

        // viewState 에 face source 까지 영속화 — 파일 복원 시 applyCrossSection 재호출 위해.
        enterSketchMode({
          planeKey: planeKey ?? "",
          planeName: currentPlaneNameRef.current,
          faceSource: { modelId: result.modelId, faceGroupId: result.faceGroupId },
        });
      }
      setActiveSketchName(currentPlaneNameRef.current);
      setSketchPending(false);
      const s = sceneRef.current;
      if (s) s.setOriginPlanesVisible(false);
    },
    [applyCrossSection, extractFacePlane, setSketchPending, setActiveSketchName, store, restoreSketch, sketchEntries, enterSketchMode],
  );

  // 기준 평면 / 참조 평면 클릭 통합 — Reference Plane 생성 모드면 base 로 설정, 아니면 sketch 진입.
  const handlePlanePick = useCallback(
    (hit: PlanePickHit) => {
      const s = sceneRef.current;
      if (!s) return;

      // hit 종류 별 SketchPlane + 표시 이름 계산
      let sketchPlane: SketchPlane | null;
      let baseName: string;
      if (hit.kind === "originPlane") {
        sketchPlane = s.getOriginPlaneAsSketchPlane(hit.index);
        baseName = ["XY Plane", "YZ Plane", "ZX Plane"][hit.index];
      } else {
        sketchPlane = s.getReferencePlaneAsSketchPlane(hit.id);
        const refPlanes = store.get(setupReferencePlanesAtom);
        baseName = refPlanes.find((p) => p.id === hit.id)?.name ?? `Plane #${hit.id}`;
      }
      if (!sketchPlane) return;

      // Reference Plane 생성 모드 — base plane 으로 설정만 하고 종료 (sketch 진입 안 함)
      const refMode = store.get(setupRefPlaneModeAtom);
      const refModeFace = refMode?.step === "select-plane"
        && (hit.kind === "originPlane" || refMode.selectionMode === "face");
      if (refModeFace) {
        store.set(setupRefPlaneModeAtom, {
          step: "select-plane",
          selectionMode: "face",
          basePlane: sketchPlane,
          basePlaneName: baseName,
        });
        return;
      }

      currentPlaneRef.current = sketchPlane;

      // 저장된 스케치가 있으면 기존 이름 유지, 없으면 Sketch N
      const planeKey = s.getPlaneKey(sketchPlane);
      const existingEntry = sketchEntries.find((e) => e.planeKey === planeKey);
      if (existingEntry) {
        currentPlaneNameRef.current = existingEntry.planeName;
      } else {
        sketchCounterRef.current += 1;
        currentPlaneNameRef.current = `Sketch ${sketchCounterRef.current}`;
      }

      setSketchPending(false);
      setSketchPlane(sketchPlane);
      s.setOriginPlanesVisible(false);
      s.setupSketchPlane(sketchPlane);

      // 해당 평면에 저장된 스케치가 있으면 엔진에 복원 + bake 지오메트리 제거
      const saved = s.getSavedSketch(sketchPlane);
      if (saved) {
        restoreSketch(saved);
        s.removeBakedSketch(sketchPlane);
      } else {
        // 새 스케치 / 엔트리만 있는 빈 스케치 (handleEnterSketchByKey 의 empty re-enter 와 같음):
        // 이전 스케치 잔여물 없이 참조 기하만 주입
        startBlankSketch(geometryStoreRef.current, constraintStoreRef.current);
      }

      setActiveSketchName(currentPlaneNameRef.current);
      enterSketchMode({ planeKey: planeKey ?? "", planeName: currentPlaneNameRef.current });
      // 진입 시점에 viewport selection 리셋 — SpecTree 의 plane 강조는 viewState.sketchPlaneKey
      // 에서 derive 되므로 selection atom 은 비워도 시각 결과 동일. exit 시 잔존 방지.
      store.set(setup3DSelectionAtom, []);
    },
    [setSketchPending, setSketchPlane, enterSketchMode, setActiveSketchName, store, restoreSketch, sketchEntries],
  );

  // planeKey + planeName으로 저장된 스케치 편집 진입 (더블클릭/Edit 용)
  const handleEnterSketchByKey = useCallback(
    (planeKey: string, planeName: string, options?: { skipAnimation?: boolean }) => {
      const s = sceneRef.current;
      if (!s) return;

      // saved sketch 가 있으면 그걸 사용, 없으면 plane 자체만 resolve (empty re-enter 케이스).
      const savedSketch = s.getSavedSketchByKey(planeKey);
      const sketchPlane = savedSketch?.plane ?? s.resolveSketchPlaneByKey(planeKey);
      if (!sketchPlane) return;

      currentPlaneRef.current = sketchPlane;
      currentPlaneNameRef.current = planeName;

      setSketchPending(false);
      setSketchPlane(sketchPlane);
      s.setOriginPlanesVisible(false);
      // skipAnimation: 파일 hydrate 흐름 — 카메라 슬러프 애니메이션 우회 (즉시 ortho 전환)
      s.setupSketchPlane(sketchPlane, undefined, options);

      if (savedSketch) {
        // 저장된 스케치 엔진에 복원 + bake 지오메트리 제거
        restoreSketch(savedSketch);
        s.removeBakedSketch(sketchPlane);
      } else {
        // empty re-enter — 이전 스케치 잔여물 없이 reference geometry 만 inject
        startBlankSketch(geometryStoreRef.current, constraintStoreRef.current);
      }

      setActiveSketchName(currentPlaneNameRef.current);
      enterSketchMode({ planeKey, planeName });
      store.set(setup3DSelectionAtom, []);
    },
    [setSketchPending, setSketchPlane, enterSketchMode, setActiveSketchName, restoreSketch, store],
  );

  // Sketch 버튼 → sketchPending true. 그 시점에 origin/ref plane 이 이미 selected 면
  // 사용자가 다시 plane 클릭할 필요 없이 즉시 진입. refPlaneMode 진행 중에는 동작 안 함
  // (refPlane 생성 흐름이 selected plane 을 base 로 활용하는 별도 path).
  useEffect(() => {
    if (!sketchPending) return;
    if (store.get(setupRefPlaneModeAtom)) return;
    const selArr = store.get(setup3DSelectionAtom);
    const planeSel = selArr.find(
      (s) => s.kind === "originPlane" || s.kind === "referencePlane",
    );
    if (planeSel) {
      handlePlanePick(planeSel as PlanePickHit);
    }
  }, [sketchPending, store, handlePlanePick]);

  // 현재 활성 sketch 의 live 데이터만 baked Map 에 저장 (engine/geoStore 정리, viewMode
  // 전환 등 부수 효과 없음). 페이지/파일 이동 직전 또는 saveFile 직전 호출 — 사용자가
  // sketch 모드 종료 안 한 채 navigate 하더라도 데이터 보존 보장.
  // 3D 모드에서 origin XY plane 으로 sketch entry 생성 + bake.
  // sketch mode 진입 없이 SpecTree 에 sketch 항목 등록.
  //
  // 기존 XY plane sketch entry 가 이미 있는 경우 — 그 entry 의 데이터
  // (사용자가 그린 line / circle 등 + constraints / shapes) 는 보존.
  const bakeOriginXY = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;
    const geoStore = geometryStoreRef.current;

    // origin XY plane — input.store 의 ORIGIN_PLANE_KEYS / SketchPlaneManager 와
    // 같은 정의. 이름은 face/plane pick 흐름과 동일하게 "Sketch N" 자동 번호 부여 —
    // SpecTree entry 가 이미 있으면 그 이름 유지 (번호 증가 방지).
    const plane: SketchPlane = {
      origin: { x: 0, y: 0, z: 0 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    };
    // 이름 fallback 우선순위:
    // 1) SpecTree atom (sketchEntries) — 평소 경로
    // 2) scene 의 savedSketch.name — 파일 로드 직후 atom 이 아직 hydrate 되기 전에
    //    호출되는 타이밍 방어 (bakeOriginXY 는 3D 모드 진입 시 자동 호출되므로 atom 보다
    //    먼저 도달할 수 있음)
    // 3) 둘 다 없으면 새 "Sketch N" 자동 번호 — face/plane pick 흐름과 동일 패턴
    const planeKey = s.getPlaneKey(plane);
    const existing = planeKey ? s.getSavedSketchByKey(planeKey) : null;
    const existingEntry = planeKey ? sketchEntries.find((e) => e.planeKey === planeKey) : null;
    let planeName: string;
    if (existingEntry) {
      planeName = existingEntry.planeName;
    } else if (existing?.name) {
      planeName = existing.name;
    } else {
      sketchCounterRef.current += 1;
      planeName = `Sketch ${sketchCounterRef.current}`;
    }

    const currentGeoms = geoStore.serialize();
    // 기존 entry 의 geometry — 사용자 작업물 보존.
    const mergedGeoms = [...(existing?.geometries ?? []), ...currentGeoms];

    // 빈 sketch 면 굳이 entry 만들 필요 없음.
    if (mergedGeoms.length === 0) return;

    // 보조 데이터 — geoStore (라이브 source) 우선. existing 은 fallback.
    // 이전엔 existing 우선이어서 사용자가
    // sketch 진입 후 role 없는 shape 추가 → 종료 시 stale existing.shapes 가 새 shape
    // 덮어 BakedSketch 와 geoStore 의 shape 집합 어긋남 → SpecTree (geoStore) ↔ 3D mesh
    // (baked) 가 다른 shape 가리킴.
    const constraints =
      constraintStoreRef.current.serialize().length > 0
        ? constraintStoreRef.current.serialize()
        : (existing?.constraints ?? []);
    const shapes =
      geoStore.shapes.length > 0
        ? geoStore.shapes.map((sh) => omitUndefined({ ...sh, holes: [] as [] }))
        : (existing?.shapes ?? []);

    s.bakeSketch(
      plane,
      mergedGeoms.length > 0 ? mergedGeoms : undefined,
      constraints.length > 0 ? constraints : undefined,
      shapes.length > 0 ? shapes : undefined,
      planeName,
    );

    // SpecTree entry 등록 — 기존 bakeCurrentSketchIfActive / handleCloseSketch 가
    // 사용하는 onSketchBaked 같은 콜백 호출.
    if (planeKey) {
      onSketchBaked?.({
        planeKey,
        planeName,
        plane,
      });
    }
  }, [onSketchBaked, sketchEntries]);

  const bakeCurrentSketchIfActive = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;
    const plane = currentPlaneRef.current;
    const geoStore = geometryStoreRef.current;
    if (!plane) return;

    const geometries = geoStore.serialize();
    if (geometries.length === 0) return;

    const shapes = geoStore.shapes;
    const constraints = constraintStoreRef.current.serialize();
    const serializedShapes = shapes.map((sh) => omitUndefined({ ...sh, holes: [] as [] }));
    s.bakeSketch(
      plane,
      geometries.length > 0 ? geometries : undefined,
      constraints.length > 0 ? constraints : undefined,
      serializedShapes.length > 0 ? serializedShapes : undefined,
      currentPlaneNameRef.current || undefined,
    );
  }, []);

  // 스케치 모드 명시적 해제 (Close Sketch)
  const handleCloseSketch = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;
    const plane = currentPlaneRef.current;
    const geoStore = geometryStoreRef.current;

    // 현재 스케치를 직렬화 + 3D 지오메트리로 bake → 스토어 클리어
    if (plane) {
      const geometries = geoStore.serialize();
      const shapes = geoStore.shapes;
      const constraints = constraintStoreRef.current.serialize();

      // CATIA 방식 — empty sketch 도 spec tree entry 유지.
      const serializedShapes = shapes.map((sh) => omitUndefined({ ...sh, holes: [] as [] }));
      s.bakeSketch(
        plane,
        geometries.length > 0 ? geometries : undefined,
        constraints.length > 0 ? constraints : undefined,
        serializedShapes.length > 0 ? serializedShapes : undefined,
        currentPlaneNameRef.current || undefined,
      );

      // OCCT Face 생성 (B-Rep pipeline — bake와 병행)
      if (shapes.length > 0) {
        // 아래 clearClosedSketch 가 geoStore.geometries 를 동기적으로 비우고, 동적 import 는 그 뒤에
        // 끝난다. 같은 Map 을 넘기면 빈 기하로 face 를 만들므로 지금 기하를 복사해 넘긴다.
        const faceGeometries = new Map(geoStore.geometries);
        import("../../step/OcctSketchNative").then(async ({ makeFaceFromShape }) => {
          for (const shape of shapes) {
            try {
              await makeFaceFromShape(shape, faceGeometries, plane);
            } catch {
              // OCCT 미사용 환경에서는 무시 (bake fallback 유지)
            }
          }
        }).catch(() => {/* OCCT 미설치 */});
      }

      // 연관 솔리드 자동 rebuild (파라메트릭 연동)
      const planeKey = s.getPlaneKey(plane);
      if (planeKey && getOperations) {
        const ops = getOperations();
        if (ops.length > 0) {
          s.rebuildOperationsForSketch(planeKey, ops);
        }
      }

      // SpecTree 엔트리 업데이트 — empty sketch 도 entry 유지 (CATIA 방식).
      if (planeKey) {
        onSketchBaked?.({
          planeKey,
          planeName: currentPlaneNameRef.current,
          plane,
        });
      }

      // shape 만 보존, line geometry / constraint 는 baked sketch 가 SSOT 이므로 clear.
      clearClosedSketch(geoStore, constraintStoreRef.current);
    }

    // 그리기 도구 상태 초기화
    setDrawToolType("select");
    setDimensionMode(null);
    setFilletMode(null);
    setChamferMode(null);
    setOffsetMode(null);

    currentPlaneRef.current = null;
    currentPlaneNameRef.current = "";
    externalSnapGeomsRef.current = [];
    s.getGeometryOverlay()?.setExternalGeometries([]);
    s.clearSketchPlane();
    s.setOriginPlanesVisible(true);
    setActiveSketchName("");
    setSketchGeometryList([]);
    setSketchConstraintList([]);
    exitSketchMode();
    setSketchPlane(null);
    setSketchPending(false);
  }, [exitSketchMode, setSketchPlane, setSketchPending, setDrawToolType, setDimensionMode, setFilletMode, setChamferMode, setOffsetMode, setActiveSketchName, setSketchGeometryList, setSketchConstraintList, onSketchBaked, getOperations]);

  // 부모에서 closeSketch / planePick / enterSketchByKey / bakeCurrent 호출할 수 있도록 ref 연결
  closeSketchRef.current = handleCloseSketch;
  pickOriginPlaneRef.current = (idx: number) => handlePlanePick({ kind: "originPlane", index: idx });
  if (enterSketchByKeyRef) {
    (enterSketchByKeyRef as React.MutableRefObject<((planeKey: string, planeName: string, options?: { skipAnimation?: boolean }) => void) | null>).current = handleEnterSketchByKey;
  }
  if (bakeCurrentSketchRef) {
    (bakeCurrentSketchRef as React.MutableRefObject<(() => void) | null>).current = bakeCurrentSketchIfActive;
  }
  if (bakeOriginXYRef) {
    (bakeOriginXYRef as React.MutableRefObject<(() => void) | null>).current = bakeOriginXY;
  }

  // 스케치 커맨드 콜백을 atom에 일괄 설정 (구속 적용, 도구 확인, SpecTree 선택 등)
  useSketchRefCallbacks({
    geometryStoreRef,
    activeDrawToolRef,
    sceneRef,
    drawToolMap,
    models,
    deletedBodies: useAtomValue(setupDeletedBodiesAtom),
    hiddenBodies: useAtomValue(setupHiddenBodiesAtom),
    setDimensionMode,
    setFilletMode,
    setFilletRadius,
    setChamferMode,
    setChamferDistance,
    setChamferDistance2,
    setOffsetMode,
    setOffsetDistance,
    filletRadius,
    chamferDistance,
    chamferDistance2,
    offsetDistance,
  });

  // sketchPending 모드: baked sketch face 클릭 → 스케치 진입 핸들러
  // refPlane select-plane 모드: baked sketch face 를 base plane 으로 사용 가능
  const handleBakedSketchFacePick = useCallback(
    (result: { planeKey: string; planeName: string }) => {
      const entry = sketchEntries.find((e) => e.planeKey === result.planeKey);
      const planeName = entry?.planeName ?? result.planeName;

      const refMode = store.get(setupRefPlaneModeAtom);
      if (refMode?.step === "select-plane" && refMode.selectionMode === "face") {
        const s = sceneRef.current;
        if (!s) return;
        const saved = s.getSavedSketchByKey(result.planeKey);
        if (saved) {
          store.set(setupRefPlaneModeAtom, {
            step: "select-plane",
            selectionMode: "face",
            basePlane: saved.plane,
            basePlaneName: planeName,
          });
        }
        return;
      }

      if (onBakedSketchFacePick) {
        onBakedSketchFacePick(result.planeKey, planeName);
      } else {
        handleEnterSketchByKey(result.planeKey, planeName);
      }
    },
    [onBakedSketchFacePick, handleEnterSketchByKey, sketchEntries, store],
  );

  // 3D 모드: extruded solid 클릭 → operation 편집
  const handleExtrudedSolidPick = useCallback(
    (result: { operationId: string }) => {
      onExtrudedSolidPick?.(result.operationId);
    },
    [onExtrudedSolidPick],
  );

  // 3D 모드: baked sketch face 클릭 → face 선택 (Ctrl+Click: 다중 선택)
  const handleBakedSketchFaceSelect = useCallback(
    (result: { planeKey: string; planeName: string; profileId?: string | null } | null, additive?: boolean) => {
      if (!result) {
        onBakedSketchFaceSelect?.(null, null, null, additive);
        return;
      }
      const entry = sketchEntries.find((e) => e.planeKey === result.planeKey);
      const planeName = entry?.planeName ?? result.planeKey;
      onBakedSketchFaceSelect?.(result.planeKey, planeName, result.profileId ?? null, additive);
    },
    [onBakedSketchFaceSelect, sketchEntries],
  );

  const {
    canvasRef,
    scene,
    handleClick,
    handlePointerMove,
    handlePointerDown,
    handlePointerUp,
    handlePointerCancel: scenePointerCancel,
    cycleHoverCandidate,
    confirmHoverCandidate,
  } = useInputSceneController({
    onFacePick: handleFacePick,
    onPlanePick: handlePlanePick,
    onBakedSketchFacePick: handleBakedSketchFacePick,
    onExtrudedSolidPick: handleExtrudedSolidPick,
    onBakedSketchFaceSelect: handleBakedSketchFaceSelect,
    onViewportHover,
    onViewportSelect,
    onBakedShapeHover: setBakedShapeHoveredId,
    onBakedShapeSelect: setBakedShapeSelectedId,
    getDrawTool,
    getGeometryStore,
    getExternalSnapGeometries,
    sketchTreeHoveringRef: sketchTreeHoveringRef as React.MutableRefObject<boolean> | undefined,
  });
  sceneRef.current = scene;
  if (externalSceneRef) {
    (externalSceneRef as React.MutableRefObject<SetupScene | null>).current = scene;
  }
  // scene 이 새로 생성된 후 (`useInputSceneController` 의 setScene 다음 cycle) callback —
  // result 페이지의 mount race fix: copyEngineMechanism 의 engine.requestRender 가 sceneRef
  // 채워지기 전에 fire 되어 hook listener 들이 bail out 한 경우, callback 시점에 engine.
  // requestRender 다시 호출하면 listener 가 catch 해서 mesh build.
  useEffect(() => {
    if (scene && onSceneReady) onSceneReady(scene);
  }, [scene, onSceneReady]);
  // 캔버스 크기 초기화
  useEffect(() => {
    if (!canvasRef.current) return;
    const parent = canvasRef.current.parentElement;
    if (!parent) return;

    canvasRef.current.width = parent.clientWidth;
    canvasRef.current.height = parent.clientHeight;

    if (scene) {
      scene.resize(parent.clientWidth, parent.clientHeight);
    }
  }, [canvasRef, scene]);


  // baked sketches atom ↔ SetupScene sync + 페이지 재진입 hydrate.
  const setBakedSketches = useSetAtom(setupBakedSketchesAtom);
  useEffect(() => {
    if (!scene) return;
    scene.setBakedChangeCallback((newSnapshot) => {
      setBakedSketches(newSnapshot);
    });

    if (scene.getSavedSketches().size === 0) {
      const fid = store.get(fileIdAtom);
      const fileData = store.get(fileDataAtomFamily(fid));
      const SetupData = deserializeSetupData(fileData.globalData.setup);
      const atomBaked = store.get(setupBakedSketchesAtom);
      const atomBakedHasData = Object.keys(atomBaked).length > 0;
      if (SetupData.sketches.length > 0 || atomBakedHasData) {
        const dataForRestore = atomBakedHasData
          ? { ...SetupData, sketches: Object.values(atomBaked) }
          : SetupData;
        store.set(setupPendingRestoreAtom, dataForRestore);
      }
    }

    return () => {
      scene.setBakedChangeCallback(null);
    };
  }, [scene, setBakedSketches, store]);

  // Fresh SetupScene (result 페이지 진입 등) 으로 mount 시 setupOperationsAtom 의 모든 op 를
  // SolidOperationManager 에 일괄 rebuild. 위 baked sketches mount effect 의 pendingRestore
  // 경로가 처리하지만 — atomBaked 가 비어있거나 navigate 직전 reset 되는 케이스를 catch
  // 못 하므로 본 effect 로 safety net.
  //
  // 멱등: 같은 op id 로 rebuildOperationsForSketch 호출 시 SolidOperationManager.addExtrudedSolid
  // 가 첫줄에 removeExtrudedSolid(id) → mesh 재생성. 누적 X. command 흐름 (CreatePadCommand
  // 등) 이 mesh 를 이미 add 했을 setup 페이지에선 ref 게이팅으로 skip → flicker / cost X.
  //
  // Gating: ref 로 (scene, fileId) tuple 당 1회만 fire. fileId 전환 시 scene 은 보존되지만
  // sketches 가 clear 되고 atom 이 갱신되므로 fileId dep 로 ref reset 후 새 sketches 복원
  // 완료 (getSavedSketches.size > 0) 까지 wait.
  const operations = useAtomValue(setupOperationsAtom);
  const fileIdForOpsRebuild = useAtomValue(fileIdAtom);
  const operationsRestoredRef = useRef(false);
  useEffect(() => {
    operationsRestoredRef.current = false;
  }, [scene, fileIdForOpsRebuild]);
  useEffect(() => {
    if (!scene || operationsRestoredRef.current) return;
    if (operations.length === 0) {
      operationsRestoredRef.current = true; // empty 도 처리 완료 — 다음 변화 시 ref true 라 skip.
      return;
    }
    if (scene.getSavedSketches().size === 0) return; // sketches 복원 대기 — 다음 bakedSketches change 시 재시도.
    const planeKeys = new Set<string>();
    for (const entry of operations) {
      if ("sketchPlaneKey" in entry.operation) {
        planeKeys.add(entry.operation.sketchPlaneKey);
      }
    }
    for (const planeKey of planeKeys) {
      scene.rebuildOperationsForSketch(planeKey, operations);
    }
    operationsRestoredRef.current = true;
  }, [scene, operations]);

  // 파일 복원 대기 스케치 처리 (scene이 준비된 후 소비)
  const pendingRestore = useAtomValue(setupPendingRestoreAtom);
  useEffect(() => {
    if (!scene || !pendingRestore) return;
    // 소비 완료 표시
    store.set(setupPendingRestoreAtom, null);

    const SetupData = pendingRestore;
    const restoredEntries: SketchTreeEntry[] = [];
    for (const sketch of SetupData.sketches) {
      const key = scene.getPlaneKey(sketch.plane);
      if (key) {
        scene.restoreSavedSketch(key, sketch);
        restoredEntries.push({
          planeKey: key,
          // 사용자 부여한 이름 (sketch.name) 우선, 없으면 planeKey fallback (구버전 호환)
          planeName: sketch.name ?? key,
          plane: sketch.plane,
        });
      }
    }
    if (restoredEntries.length > 0) store.set(setupSketchEntriesAtom, restoredEntries);

    // Solid operations (Pad/Pocket/Revolve) 재빌드 — 파일 전환 effect 가 scene.clearAllSketches
    // 로 SolidOperationManager 를 비웠고, sketches 가 위 loop 에서 복원되어 plane 기하 사용 가능.
    // sketchPlaneKey 별로 rebuildOperationsForSketch 호출 (내부에서 같은 plane 의 op 만 필터).
    if (SetupData.operations.length > 0) {
      const planeKeys = new Set<string>();
      for (const op of SetupData.operations) {
        if ("sketchPlaneKey" in op.operation) {
          planeKeys.add(op.operation.sketchPlaneKey);
        }
      }
      for (const planeKey of planeKeys) {
        scene.rebuildOperationsForSketch(planeKey, SetupData.operations);
      }
    }

    // shapes/definitions/EE는 SerializedSketch.shapes에 포함 — 스케치 진입 시 restoreSketch에서 복원
    // 3D 모드에서 geoStore에 직접 조작하면 geometry 없이 face만 렌더됨 (ghost face)

    // 뷰 상태 복원 (스케치 모드였으면 해당 plane으로 재진입)
    if (SetupData.viewState.mode === "2d-section") {
      const planeKey = SetupData.viewState.sketchPlaneKey;
      const planeName = SetupData.viewState.sketchPlaneName ?? planeKey ?? "";
      const faceSource = SetupData.viewState.sketchFaceSource;

      if (faceSource) {
        // STEP body face sketch — applyCrossSection 으로 SketchPlane 재계산 (face geometry 기반).
        // 모델은 useInputSceneController 가 reactive sync 로 이미 scene 에 add 한 상태.
        const crossSection: CrossSectionDef = {
          type: "face",
          faceGroupId: faceSource.faceGroupId,
        };
        const plane = applyCrossSection(faceSource.modelId, crossSection);
        if (plane) {
          currentPlaneRef.current = plane;
          currentPlaneNameRef.current = planeName;
          const saved = scene.getSavedSketch(plane);
          if (saved) {
            restoreSketch(saved);
            scene.removeBakedSketch(plane);
          } else {
            startBlankSketch(geometryStoreRef.current, constraintStoreRef.current);
          }
          setActiveSketchName(planeName);
          setSketchPending(false);
          scene.setOriginPlanesVisible(false);
          // viewState 도 atom 에 재기록 — 다른 entry 경로 (handleEnterSketchByKey / Origin /
          // Reference) 와 대칭. atom 이미 같은 값이라면 no-op (Jotai 가 Object.is 비교).
          const restoredKey = scene.getPlaneKey(plane);
          if (restoredKey) {
            enterSketchMode({ planeKey: restoredKey, planeName, faceSource });
          }
        }
      } else if (planeKey && enterSketchByKeyRef?.current) {
        // origin / reference / saved-by-key plane — 이름으로 재진입.
        // file hydrate 흐름 — 카메라 애니메이션 skip (3D 시점 잠깐 보였다 2D 로 전환되는 모션 우회).
        enterSketchByKeyRef.current(planeKey, planeName, { skipAnimation: true });
      }
    }
    // flush와 originData 동기화는 index.tsx의 flushInputSync 및 fileId 전환 effect에서 처리
  }, [scene, pendingRestore, store, enterSketchByKeyRef, applyCrossSection, restoreSketch, setActiveSketchName, setSketchPending, enterSketchMode]);

  // ViewCube + GeometryOverlay 초기화
  useEffect(() => {
    if (!scene) return;

    scene.initViewCube();

    const geoOverlay = scene.initGeometryOverlay();
    geoOverlay.attachStore(geometryStore);
    geoOverlay.attachConstraintStore(constraintStore);
    geoOverlay.setVisible(false);
    // 외부 기하 초기 설정 (이미 캐시된 경우)
    if (externalSnapGeomsRef.current.length > 0) {
      geoOverlay.setExternalGeometries(externalSnapGeomsRef.current);
    }

    return () => {
      geoOverlay.detachConstraintStore();
      geoOverlay.detachStore();
    };
  }, [scene, geometryStore, constraintStore]);

  // viewMode 변화 시 overlay 가시성 동기 — 2D 스케치 모드에서만 표시.
  useEffect(() => {
    if (!scene) return;
    const geoOverlay = scene.getGeometryOverlay();
    if (!geoOverlay) return;
    geoOverlay.setVisible(viewMode === "2d-section");
  }, [scene, viewMode]);

  // drawTool 변경 시 geometry overlay에 전달
  useEffect(() => {
    if (!scene) return;
    const geoOverlay = scene.getGeometryOverlay();
    if (geoOverlay) geoOverlay.setDrawTool(activeDrawTool);
  }, [scene, activeDrawTool]);

  // 도구 전환 시 패널 상태 동기화: dimension이 아니면 닫기, fillet/chamfer/offset도 마찬가지
  useEffect(() => {
    if (drawToolType !== "dimension") setDimensionMode(null);
    if (drawToolType !== "fillet") setFilletMode(null);
    if (drawToolType !== "chamfer") setChamferMode(null);
    if (drawToolType !== "offset") setOffsetMode(null);
  }, [drawToolType, setDimensionMode, setFilletMode, setChamferMode, setOffsetMode]);

  // 구속조건 표시 토글 동기화
  useEffect(() => {
    if (!scene) return;
    const geoOverlay = scene.getGeometryOverlay();
    if (geoOverlay) geoOverlay.setConstraintVisible(constraintVisible);
  }, [scene, constraintVisible]);

  // 구속조건 타입별 필터 동기화
  useEffect(() => {
    if (!scene) return;
    const geoOverlay = scene.getGeometryOverlay();
    if (geoOverlay) geoOverlay.setConstraintFilter(constraintFilter);
  }, [scene, constraintFilter]);

  // Parent/Child 의존성 하이라이트 동기화 — selection 변경 시 직접 연결된 이웃 계산
  const sketchSelectedIdsValue = useAtomValue(setupSketchSelectedIdsAtom);
  const sketchSelectedCId = useAtomValue(setupSketchSelectedConstraintIdAtom);
  useEffect(() => {
    if (!scene) return;
    const geoOverlay = scene.getGeometryOverlay();
    if (!geoOverlay) return;
    const geoStore = geoOverlay.getStore();
    const cStore = geoStore?.constraintStore ?? null;
    const hl = computeDependencyHighlight(sketchSelectedIdsValue, sketchSelectedCId, cStore, geoStore?.geometries);
    geoOverlay.setDependencyHighlight(hl.geomIds, hl.constraintIds);
  }, [scene, sketchSelectedIdsValue, sketchSelectedCId]);

  // Undo/Redo 플래시 동기화
  useEffect(() => {
    if (!scene) return;
    const geoOverlay = scene.getGeometryOverlay();
    if (geoOverlay) geoOverlay.setFlashGeomIds(new Set(undoFlashIds));
  }, [scene, undoFlashIds]);

  // (구속조건 hover는 store.hoveredItem으로 통합 — 별도 동기화 불필요)

  // 기하 스토어 렌더 시 구속 applicability + solve status atom 갱신
  // dimension 도구 활성 시 선택 변경 → 자동 감지 → 패널 열기
  // 선택 변경 시 selection info atom 갱신
  useEffect(() => {
    let lastSelectedIds: string[] = [];
    let lastSelectedVertices = geometryStore.selectedVertices;
    let lastGeometryVersion = -1;
    let lastShapeVersion = -1;
    const unsub = geometryStore.addRenderListener(() => {
      setConstraintSolveStatus(geometryStore.solveStatus);
      // constraint 변경 (추가/삭제 toggle 포함) 시에도 toolbar 상태 갱신 — 매 listener 호출에서 갱신.
      // **idempotent 보장** — Set 매번 새 instance 라 setupAtom same-field skip 통과 → globalData
      // mutate → fileData mutate → isModifiedAtomFamily deep compare → cycle → freeze.
      // content (size + 모든 element 동일) 같으면 prev 반환해 atom mutate 자체 차단.
      setConstraintApplied((prev) => {
        const next = getAppliedConstraintTypes(geometryStore);
        if (prev.size === next.size) {
          let same = true;
          for (const v of prev) {
            // prev/next 둘 다 string 기반 (atom type Set<string>) — 실제 Constraint type 값 동일.
            if (!next.has(v as never)) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next as Set<string>;
      });
      // selectedIds 또는 selectedVertices 변경 시 applicability 재계산
      if (geometryStore.selectedIds !== lastSelectedIds || geometryStore.selectedVertices !== lastSelectedVertices) {
        lastSelectedIds = geometryStore.selectedIds;
        lastSelectedVertices = geometryStore.selectedVertices;
        // **idempotent 보장** — applicability object 매번 새 ref. shallow equal 후 same 이면 prev.
        setConstraintApplicability((prev) => {
          const next = getConstraintApplicability(geometryStore);
          const prevKeys = Object.keys(prev) as Array<keyof ConstraintApplicability>;
          const nextKeys = Object.keys(next) as Array<keyof ConstraintApplicability>;
          if (prevKeys.length === nextKeys.length) {
            let same = true;
            for (const k of prevKeys) {
              if (prev[k] !== next[k]) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          return next;
        });

        // dimension 도구 활성 시 panel 자동 열기 제거 — 첫 배치는 default 값으로 추가만,
        // panel 은 더블클릭 시 (handleDoubleClick) 만 열림.

        // 선택 정보 atom 갱신
        setSelectionInfo(computeSelectionInfo(geometryStore));

        // SpecTree 스케치 모드: 선택 동기화
        setSketchSelectedIds([...geometryStore.selectedIds]);
      }

      // SpecTree 스케치 모드: hover 동기화 (캔버스 → SpecTree, 통합 hoveredItem)
      setSketchHoveredItem(geometryStore.hoveredItem);

      // SpecTree 스케치 모드: 구속조건 선택 동기화 (캔버스 → SpecTree).
      // dimension 편집 패널은 더블클릭 시 (handleDoubleClick) 만 열림 — 단순 select 시
      // 자동으로 열지 않음.
      const selCstId = geometryStore.selectedConstraintId;
      setSketchSelectedConstraintId(selCstId);
      if (!selCstId && activeDrawToolRef.current?.type !== "dimension") {
        // 구속 선택 해제 + dimension 도구가 아닌 경우 패널 닫기
        setDimensionMode(null);
      }

      // SpecTree 스케치 모드: 기하/구속 목록 동기화 (기하 변경 시에만 리빌드)
      const geoChanged = geometryStore.geometryVersion !== lastGeometryVersion;
      const shapesChanged = geometryStore.shapeVersion !== lastShapeVersion;
      if (geoChanged) {
        lastGeometryVersion = geometryStore.geometryVersion;
        setSketchGeometryList(buildSketchGeometryList(geometryStore));
      }
      // Shape 목록: 기하 변경 또는 shape 목록 변경 시 재빌드.
      if (geoChanged || shapesChanged) {
        lastShapeVersion = geometryStore.shapeVersion;
        const shapeItems: SketchShapeTreeItem[] = [];
        let imageIdx = 0;
        for (let i = 0; i < geometryStore.shapes.length; i++) {
          const s = geometryStore.shapes[i];
          const label = `Shape ${i + 1}`;
          let suffixText = "";
          // Image suffix — image shape 면 [Image N].
          if (s.image) {
            imageIdx++;
            suffixText += `[Image ${imageIdx}]`;
          }
          shapeItems.push({
            id: s.id,
            label,
            // gray-400 — Image suffix 등 부가 라벨 색.
            labelSuffix: suffixText ? { text: suffixText, color: "#9199a1" } : undefined,
            lineIds: [...s.lineIds],
          });
        }
        setSketchShapeList(shapeItems);
        if (geometryStore.constraintStore) {
          setSketchConstraintList(buildSketchConstraintList(geometryStore.constraintStore));
        }
      }
    });
    return unsub;
  }, [geometryStore, setConstraintApplicability, setConstraintApplied, setConstraintSolveStatus, setDimensionMode, setSelectionInfo, setSketchGeometryList, setSketchShapeList, setSketchConstraintList, setSketchSelectedIds, setSketchHoveredItem, setSketchSelectedConstraintId]);

  // 모델 목록 변화 → 씬 동기화 (삭제된 모델의 3D 메시 제거)
  useEffect(() => {
    if (!scene) return;
    const sceneIds = scene.getStepModelIds();
    const atomIds = new Set(models.map((m) => m.id));
    for (const id of sceneIds) {
      if (!atomIds.has(id)) {
        scene.removeStepModel(id);
      }
    }
  }, [models, scene]);

  // 더블클릭: dimension 구속 값 편집
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!scene || viewMode !== "2d-section") return;

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const worldPos = scene.raycastSketchPlane(new THREE.Vector2(ndcX, ndcY));
      if (!worldPos) return;

      const scale = computeEngineScale(scene);
      const hitRadius = HIT_BUFFER / scale;

      // 구속조건 더블클릭 → dimension이면 값 편집 패널 열기
      const geoOverlay = scene.getGeometryOverlay();
      if (geoOverlay) {
        const hitConstraintId = geoOverlay.hitTestConstraint(worldPos, hitRadius);
        if (hitConstraintId) {
          const gStore = geometryStoreRef.current;
          const constraint = gStore.constraintStore?.constraints.get(hitConstraintId);
          if (constraint) {
            const dimType = constraint.type as string;
            if (dimType === "distance" || dimType === "horizontal_distance" || dimType === "vertical_distance" ||
                dimType === "line_length" || dimType === "line_angle" || dimType === "angle" ||
                dimType === "radius" || dimType === "diameter" || dimType === "point_line_distance") {
              // 현재 값 추출
              const currentValue = "value" in constraint ? (constraint as { value: number }).value : 0;
              gStore.selectedConstraintId = hitConstraintId;
              gStore.requestRender();
              setDimensionMode({ type: dimType, defaultValue: currentValue });
            }
          }
          return;
        }
      }
    },
    [scene, viewMode, canvasRef, setDimensionMode],
  );

  // 우클릭 컨텍스트 메뉴
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (!scene) return;

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const ndcVec = new THREE.Vector2(ndcX, ndcY);

      // 3D 모드: mesh-level 레이캐스트 — volume tier 만 우클릭 메뉴 대상.
      // step.volume (STEP body) 만 우클릭 메뉴 대상.
      if (viewMode !== "2d-section") {
        const entities = scene.pickEntities(ndcVec, "volume");
        const stepVol = entities.find((en) => en.source === "step" && en.kind === "volume");
        if (stepVol && stepVol.source === "step" && stepVol.kind === "volume") {
          const alreadySelected = scene.selectedBodies.some(
            (b) => b.modelId === stepVol.modelId && b.bodyIndex === stepVol.bodyIndex,
          );
          if (!alreadySelected) {
            scene.selectBody(stepVol.modelId, stepVol.bodyIndex);
          }
          onModelContextMenu?.(e, stepVol.modelId, stepVol.bodyIndex);
        }
        return;
      }

      const worldPos = scene.raycastSketchPlane(ndcVec);
      if (!worldPos) return;

      const scale = computeEngineScale(scene);
      const hitRadius = HIT_BUFFER / scale;

      // 구속조건 히트 테스트 (우클릭 → 편집/삭제 컨텍스트 메뉴)
      const geoOverlay = scene.getGeometryOverlay();
      if (geoOverlay) {
        const hitConstraintId = geoOverlay.hitTestConstraint(worldPos, hitRadius);
        if (hitConstraintId) {
          const gStore = geometryStoreRef.current;
          const constraint = gStore.constraintStore?.constraints.get(hitConstraintId);
          const constraintItems: ContextMenuItem[] = [];
          // Dimension 구속이면 "값 편집" 항목 추가
          const isDimension = constraint && (
            constraint.type === "distance" || constraint.type === "horizontal_distance" || constraint.type === "vertical_distance" ||
            constraint.type === "line_length" || constraint.type === "line_angle" ||
            constraint.type === "angle" || constraint.type === "radius" || constraint.type === "diameter" ||
            constraint.type === "point_line_distance"
          );
          if (isDimension) {
            const dimValue = "value" in constraint ? (constraint as { value: number }).value : 0;
            const dimType = constraint.type as DimensionConstraintType;
            constraintItems.push({
              type: "item",
              label: "Edit Value",
              onClick: () => {
                gStore.selectedConstraintId = hitConstraintId;
                gStore.requestRender();
                setDimensionMode({ type: dimType, defaultValue: dimValue });
              },
            });
            constraintItems.push({ type: "separator" });
          }
          constraintItems.push({
            type: "item",
            label: "Delete Constraint",
            onClick: () => {
              gStore.removeConstraintById(hitConstraintId);
            },
          });
          setContextMenu({
            visible: true,
            x: e.clientX,
            y: e.clientY,
            items: constraintItems,
          });
          return;
        }
      }

      // 스케치 기하 우클릭 → Construction 토글 / Delete.
      const geoStore = geometryStoreRef.current;
      if (geoStore) {
        const hitGeomId = geoStore.hitTest(worldPos, hitRadius);
        if (hitGeomId && !isReferenceId(hitGeomId)) {
          if (!geoStore.selectedIds.includes(hitGeomId)) {
            geoStore.selectedIds = [hitGeomId];
            geoStore.requestRender();
          }
          const hitGeom = geoStore.geometries.get(hitGeomId);
          const isConstruction =
            hitGeom && "isConstruction" in hitGeom && hitGeom.isConstruction;
          const menuItems: ContextMenuItem[] = [];
          menuItems.push({
            type: "item",
            label: isConstruction ? "Set as Standard" : "Set as Construction",
            onClick: () => {
              geoStore.toggleConstruction();
            },
          });
          menuItems.push({ type: "separator" });
          menuItems.push({
            type: "item",
            label: "Delete",
            onClick: () => {
              geoStore.deleteSelected();
            },
          });
          setContextMenu({
            visible: true,
            x: e.clientX,
            y: e.clientY,
            items: menuItems,
          });
          return;
        }
      }

      // 스케치 모드 빈 공간 우클릭 → Select All / Delete Selected
      if (geoStore) {
        const sketchMenuItems: ContextMenuItem[] = [];

        sketchMenuItems.push({
          type: "item",
          label: "Select All",
          onClick: () => {
            const allIds = [...geoStore.geometries.keys()].filter((id) => !isReferenceId(id));
            geoStore.selection = allIds.map((id) => ({ kind: "geometry" as const, geomId: id }));
            geoStore.requestRender();
          },
        });
        if (geoStore.selectedIds.length > 0) {
          sketchMenuItems.push({
            type: "item",
            label: "Delete Selected",
            onClick: () => geoStore.deleteSelected(),
          });
        }
        setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items: sketchMenuItems });
        return;
      }

      // (joint/link hit / element gallery 분기는 위 `if (geoStore) return` 으로 도달 불가 dead
      // code 였음 — 제거됨. linkage hit 컨텍스트 메뉴는 향후 필요 시 sketch 분기 안에서 처리.)
    },
    [viewMode, scene, canvasRef, setContextMenu, onModelContextMenu, setDimensionMode],
  );

  // 키보드 핸들러 → window 레벨 등록 (포커스 위치 무관하게 동작)
  useSketchKeyboardHandler({
    viewMode,
    scene,
    getGeometryStore,
    getDrawTool,
    clipboardRef,
    pasteCountRef,
    setDrawToolType,
    setDimensionMode,
    onDeleteSelectedBodies,
    onDeleteSelectedOperation,
    globalHistory,
    requestFullRedraw: () => sceneRef.current?.getGeometryOverlay()?.requestFullRedraw(),
    onCycleHoverCandidate: cycleHoverCandidate,
    onConfirmHoverCandidate: confirmHoverCandidate,
  });

  // 포인터 캡처 취소 → 드래그 도구 + 씬 컨트롤러 상태 초기화
  const handlePointerCancel = useCallback(() => {
    const tool = activeDrawToolRef.current;
    const geoStore = geometryStoreRef.current;
    if (tool && geoStore) {
      tool.onPointerCancel(geoStore);
    }
    scenePointerCancel();
  }, [scenePointerCancel]);


  return (
    <div className="input-canvas">
      <canvas
        ref={canvasRef}
        className="input-canvas__viewport"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onContextMenu={handleContextMenu}
        onPointerCancel={handlePointerCancel}
      />
      {/* ParameterEditor / DesignTableEditor 제거 (사용자 결정 — 베타 단계에서 불필요).
          토글 atom 과 store / Command 인프라는 그대로 유지 — 향후 재도입 가능. */}
      <PreSelectionNavigator />
      {children}
    </div>
  );
};

export default memo(SetupCanvas);
