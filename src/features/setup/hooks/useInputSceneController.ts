// SetupScene 라이프사이클 관리 훅 (오케스트레이터)
// 서브 훅: use3DPickHandler, useDragController, useSketchPointerHandler

import { useAtomValue, useSetAtom } from "jotai";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { HIT_BUFFER } from "src/shared/constants/CanvasConstants";

import SetupScene from "../rendering/SetupScene";
import { setupGridSnapEnabledAtom, setupGridVisibleAtom, setupModelsAtom, setupPickCandidatesNavAtom, setupRefPlaneModeAtom, setupSelectionFilterAtom, setupSketchPlaneSelectionPendingAtom, setupSketchWorldPosAtom, setupSnapDisplayAtom, setupSnapEnabledAtom, setupViewModeAtom } from "../Setup.store";
import type { SerializedGeometry } from "../Setup.type";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import { SnapEngine } from "../sketch/SnapEngine";
import type { DrawTool } from "../sketch/tools/DrawTool";

import { use3DPickHandler, type PlanePickHit, type ViewportHover } from "./use3DPickHandler";
import { useDragController } from "./useDragController";
import { useSketchPointerHandler } from "./useSketchPointerHandler";

// 스냅 타입 → 표시 라벨
const SNAP_TYPE_LABEL: Record<string, string> = {
  origin: "Origin", endpoint: "Endpoint", intersection: "Intersection",
  midpoint: "Midpoint", center: "Center", tangent: "Tangent",
  extension: "Extension", perpendicular: "Perpendicular",
  nearest: "Nearest", grid: "Grid",
};

type FacePickResult = {
  modelId: string;
  faceGroupId: number;
  point: THREE.Vector3;
};

export type SetupSceneController = {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  scene: SetupScene | null;
  handleClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handlePointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerCancel: () => void;
  /** Tab 키 등으로 PreSelection 후보 순환 (CATIA Sketcher 동작) */
  cycleHoverCandidate: () => void;
  confirmHoverCandidate: () => void;
};

type BodyPickResult = {
  modelId: string;
  bodyIndex: number;
};

type BakedSketchFacePickResult = {
  planeKey: string;
  planeName: string;
  profileId?: string | null;
};

type ExtrudedSolidPickResult = {
  operationId: string;
};

type UseInputSceneControllerOptions = {
  onFacePick?: (result: FacePickResult) => void;
  /** Plane pick (origin / reference 통합) — sketchPending / refPlane base 설정 흐름. */
  onPlanePick?: (hit: PlanePickHit) => void;
  onBakedSketchFacePick?: (result: BakedSketchFacePickResult) => void;
  onBodySelect?: (result: BodyPickResult | null) => void;
  onExtrudedSolidPick?: (result: ExtrudedSolidPickResult) => void;
  onBakedSketchFaceSelect?: (result: BakedSketchFacePickResult | null, additive?: boolean) => void;
  /** 3D viewport 통합 hover (origin plane / ref plane / extruded solid) — null = none. */
  onViewportHover?: (hit: ViewportHover | null) => void;
  /** 3D viewport 통합 select — null = clear. */
  onViewportSelect?: (hit: ViewportHover | null) => void;
  /** Baked sketch face hover/select — 부모가 SpecTree 와 sync 하는 atom set. */
  onBakedShapeHover?: (id: string | null) => void;
  onBakedShapeSelect?: (id: string | null) => void;
  getDrawTool?: () => DrawTool | null;
  getGeometryStore?: () => SketchGeometryStore | null;
  getExternalSnapGeometries?: () => SerializedGeometry[];
  /** SpecTree에서 기하/구속에 hover 중이면 true */
  sketchTreeHoveringRef?: React.MutableRefObject<boolean>;
};

// 카메라 거리 + FOV로 pixels-per-world-unit 계산 (ortho/persp 분기)
export const computeEngineScale = (scene: SetupScene): number => {
  const cam = scene.camera;
  const canvas = scene.renderer.domElement;

  if (cam instanceof THREE.OrthographicCamera) {
    const zoom = cam.zoom || 1;
    const frustumHeight = cam.top - cam.bottom;
    if (frustumHeight === 0) return 1;
    return canvas.clientHeight * zoom / frustumHeight;
  }

  const fovRad = ((cam as THREE.PerspectiveCamera).fov * Math.PI) / 180;
  const dist = cam.position.distanceTo(scene.controls.target);
  return canvas.clientHeight / (2 * dist * Math.tan(fovRad / 2));
};

export const useInputSceneController = ({
  onFacePick,
  onPlanePick,
  onBakedSketchFacePick,
  onBodySelect,
  onExtrudedSolidPick,
  onBakedSketchFaceSelect,
  onViewportHover,
  onViewportSelect,
  onBakedShapeHover,
  onBakedShapeSelect,
  getDrawTool,
  getGeometryStore,
  getExternalSnapGeometries,
  sketchTreeHoveringRef,
}: UseInputSceneControllerOptions = {}): SetupSceneController => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<SetupScene | null>(null);
  const snapEngine = useMemo(() => new SnapEngine(), []);

  const models = useAtomValue(setupModelsAtom);
  const viewMode = useAtomValue(setupViewModeAtom);
  const sketchPending = useAtomValue(setupSketchPlaneSelectionPendingAtom);
  const setSnapDisplay = useSetAtom(setupSnapDisplayAtom);
  const setSketchWorldPos = useSetAtom(setupSketchWorldPosAtom);
  const snapEnabled = useAtomValue(setupSnapEnabledAtom);
  const gridSnapEnabled = useAtomValue(setupGridSnapEnabledAtom);
  const gridVisible = useAtomValue(setupGridVisibleAtom);

  // Grid 스냅 토글 → SnapEngine 동기화 (기하 스냅은 별도 atom/플래그)
  useEffect(() => {
    snapEngine.gridSnapEnabled = gridSnapEnabled;
  }, [snapEngine, gridSnapEnabled]);
  const sketchMode = viewMode === "2d-section";

  // 씬 초기화
  useEffect(() => {
    if (!canvasRef.current) return;

    const inputScene = new SetupScene(canvasRef.current);
    setScene(inputScene);

    return () => {
      inputScene.dispose();
    };
  }, []);

  // 리사이즈 처리
  useEffect(() => {
    if (!scene || !canvasRef.current) return;

    const container = canvasRef.current.parentElement;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) continue;
        scene.resize(width, height);
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [scene]);

  // 그리드 표시 토글 동기화
  useEffect(() => {
    if (scene) scene.gridVisible = gridVisible;
  }, [scene, gridVisible]);

  // 모델 동기화
  useEffect(() => {
    if (!scene) return;

    for (const model of models) {
      if (!scene.getStepModelGroup(model.id)) {
        scene.addStepModel(model);
      }
    }

    const atomIds = new Set(models.map((m) => m.id));
    for (const id of scene.getStepModelIds()) {
      if (!atomIds.has(id)) {
        scene.removeStepModel(id);
      }
    }
  }, [scene, models]);

  // NDC 좌표 계산
  const getNDC = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      return { x, y };
    },
    [],
  );

  // 스냅 적용 헬퍼
  const applySnap = useCallback(
    (pos: { x: number; y: number }, geoStore: SketchGeometryStore | null, suppressSnap?: boolean): { x: number; y: number } => {
      if (!scene) return pos;
      // 스냅 비활성 시 모든 스냅 억제
      if (!snapEnabled) {
        if (geoStore) {
          geoStore.snapResult = null;
          geoStore.requestRender();
        }
        setSnapDisplay(null);
        return pos;
      }
      const gridSpacing = scene.getGridSpacing();
      const scale = computeEngineScale(scene);
      const extGeoms = getExternalSnapGeometries?.();
      const drawTool = getDrawTool?.();
      const allowedTypes = drawTool?.snapFilter ?? null;
      const result = snapEngine.snap(pos, gridSpacing, geoStore, HIT_BUFFER * 2, scale, extGeoms, suppressSnap, allowedTypes);
      if (geoStore) {
        geoStore.snapResult = result;
        geoStore.requestRender();
      }
      // DOM 오버레이용 스냅 정보 갱신
      if (result && result.type !== "grid") {
        setSnapDisplay({ type: SNAP_TYPE_LABEL[result.type] ?? result.type, x: result.x, y: result.y });
      } else {
        setSnapDisplay(null);
      }
      return result ? { x: result.x, y: result.y } : pos;
    },
    [scene, snapEngine, snapEnabled, getExternalSnapGeometries, setSnapDisplay, getDrawTool],
  );

  // --- 서브 훅 구성 ---

  const selectionFilter = useAtomValue(setupSelectionFilterAtom);
  const refPlaneMode = useAtomValue(setupRefPlaneModeAtom);
  const setRefPlaneMode = useSetAtom(setupRefPlaneModeAtom);

  // edge pick → refPlane 모드에서 edge 정보 저장
  const handleEdgePick = useCallback((result: { modelId: string; bodyIndex: number; edgeIndex: number; point: { x: number; y: number; z: number } }) => {
    if (refPlaneMode?.selectionMode !== "edge") return;
    if (!scene) return;
    // edge의 양 끝점을 scene에서 가져오기
    const edgePoints = scene.getEdgeEndpoints(result.modelId, result.bodyIndex, result.edgeIndex);
    if (edgePoints) {
      setRefPlaneMode({
        ...refPlaneMode,
        step: "input-distance",
        edgeStart: edgePoints.start,
        edgeEnd: edgePoints.end,
        basePlaneName: `Edge #${result.edgeIndex}`,
      });
    } else {
      // fallback: click point를 중심으로 작은 edge 추정
      setRefPlaneMode({
        ...refPlaneMode,
        step: "input-distance",
        edgeStart: result.point,
        edgeEnd: { x: result.point.x, y: result.point.y + 10, z: result.point.z },
        basePlaneName: `Edge #${result.edgeIndex}`,
      });
    }
  }, [refPlaneMode, scene, setRefPlaneMode]);

  // PreSelection Navigator atom — sketch / 3D 둘 다 사용. 선언 순서상 use3DPickHandler 호출
  // 전에 setter 를 확보하기 위해 여기서 useSetAtom 호출.
  const setPreSelectionNav = useSetAtom(setupPickCandidatesNavAtom);

  const { handle3DClick, handle3DPointerDown, handle3DPointerUp, handle3DPointerMove, cycle3DHoverCandidate, confirm3DHoverCandidate } = use3DPickHandler(
    scene, getNDC, sketchPending, models, selectionFilter, refPlaneMode, sketchMode,
    { onFacePick, onEdgePick: handleEdgePick, onPlanePick, onBakedSketchFacePick, onBodySelect, onExtrudedSolidPick, onBakedSketchFaceSelect, onViewportHover, onViewportSelect, setPreSelectionNav, onBakedShapeHover, onBakedShapeSelect },
  );

  const { dragRef, handleDragMove, handleDragEnd, handleDragCancel } = useDragController(
    scene,
    {
      getGeometryStore,
      getDrawTool,
    },
  );

  // selectionFilter는 ref로 전달해 closure 캡처 회피 (atom 변경 즉시 반영)
  const selectionFilterRef = useRef(selectionFilter);
  selectionFilterRef.current = selectionFilter;

  const { handleSketchPointerDown, handleSketchPointerUp, handleSketchPointerMove, cycleHoverCandidate, confirmHoverCandidate } = useSketchPointerHandler(
    scene, getNDC,
    {
      getDrawTool, getGeometryStore,
      applySnap, setSketchWorldPos,
      // getter로 전달하여 항상 최신 snapRadius 사용 (applySnap에서 갱신됨)
      getSnapInferenceRadius: () => snapEngine.snapRadius,
      dragRef,
      sketchTreeHoveringRef,
      getSelectionFilter: () => selectionFilterRef.current,
      setPreSelectionNav,
      // 2D sketch 빈 공간 클릭 시 shape selection 해제.
      onEmptyClick: () => {
        onBakedShapeSelect?.(null);
      },
    },
  );

  // --- 통합 핸들러 ---

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!scene) return;
      if (sketchMode) return; // 스케치 모드에서는 click 이벤트 미사용
      handle3DClick(e);
    },
    [scene, sketchMode, handle3DClick],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene) return;
      // CATIA 정합 — 클릭 시점에 PreSelection Navigator 즉시 숨김.
      setPreSelectionNav(null);

      if (sketchMode) {
        handleSketchPointerDown(e);
      } else {
        // 우클릭 무시 (3D 모드에서는 오비트에 사용)
        if (e.button !== 0) return;
        handle3DPointerDown(e);
      }
    },
    [scene, sketchMode, handleSketchPointerDown, handle3DPointerDown, setPreSelectionNav],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene || e.button !== 0) return;
      if (!sketchMode) {
        handle3DPointerUp(e);
        return;
      }

      // 스케치 모드: 드래그 완료 시도 → DrawTool 라우팅
      const ndc = getNDC(e);
      if (!ndc) return;
      const ndcVec = new THREE.Vector2(ndc.x, ndc.y);
      const vec2 = scene.raycastSketchPlane(ndcVec);
      if (!vec2) return;

      // 드래그 완료 처리 (박스 선택, 이동 커밋, vertex 클릭)
      if (dragRef.current) {
        if (handleDragEnd(vec2, e)) return;
      }
      dragRef.current = null;

      handleSketchPointerUp(e);
    },
    [scene, sketchMode, getNDC, handle3DPointerUp, handleSketchPointerUp, dragRef, handleDragEnd],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene) return;

      const ndc = getNDC(e);
      if (!ndc) return;
      const ndcVecPre = new THREE.Vector2(ndc.x, ndc.y);

      if (sketchMode) {
        handleSketchPointerMove(e, handleDragMove);
      } else {
        // PreSelection Navigator 위치용 screen 좌표 (canvas-relative px).
        handle3DPointerMove(ndcVecPre, { x: e.clientX, y: e.clientY });
      }
    },
    [scene, getNDC, sketchMode, handleSketchPointerMove, handleDragMove, handle3DPointerMove],
  );

  const handlePointerCancel = useCallback(() => {
    handleDragCancel();
    const geoStore = getGeometryStore?.();
    if (geoStore) {
      geoStore.snapResult = null;
      geoStore.requestRender();
    }
    setSnapDisplay(null);
  }, [handleDragCancel, getGeometryStore, setSnapDisplay]);

  // PreSelection Navigator — Tab/Enter 가 sketch / 3D 모드에 따라 분기.
  const unifiedCycleHoverCandidate = useCallback(() => {
    if (sketchMode) cycleHoverCandidate();
    else cycle3DHoverCandidate();
  }, [sketchMode, cycleHoverCandidate, cycle3DHoverCandidate]);

  const unifiedConfirmHoverCandidate = useCallback(() => {
    if (sketchMode) confirmHoverCandidate();
    else confirm3DHoverCandidate();
  }, [sketchMode, confirmHoverCandidate, confirm3DHoverCandidate]);

  return {
    canvasRef,
    scene,
    handleClick,
    handlePointerMove,
    handlePointerDown,
    handlePointerUp,
    handlePointerCancel,
    cycleHoverCandidate: unifiedCycleHoverCandidate,
    confirmHoverCandidate: unifiedConfirmHoverCandidate,
  };
};
