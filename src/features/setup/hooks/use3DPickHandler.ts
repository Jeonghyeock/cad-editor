// 3D 모드 포인터 핸들러: ViewCube, face pick, origin plane, body/solid 선택, mesh hover

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";

import type {
  PickEntity,
  PickEntityKind,
  PickEntitySource,
  Pick3DTarget,
} from "../rendering/picking/EntityPicker";
import type SetupScene from "../rendering/SetupScene";
import type { PreSelectionCandidate, RefPlaneCreationState } from "../Setup.store";
import type { EdgePickResult, SelectionFilterMode, StepModelData, VertexPickResult } from "../Setup.type";

type FacePickResult = {
  modelId: string;
  faceGroupId: number;
  point: THREE.Vector3;
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

/** 3D viewport 통합 hover/select 식별자 (Input.store 의 ViewportHoverItem 와 동일 shape). */
export type ViewportHover =
  | { kind: "originPlane"; index: number }
  | { kind: "referencePlane"; id: string }
  | { kind: "solid"; operationId: string };

/** Plane pick (sketch 진입 / refPlane base 설정 용) — origin / reference 통합. */
export type PlanePickHit =
  | { kind: "originPlane"; index: number }
  | { kind: "referencePlane"; id: string };

/** 3D pick 흐름의 모드. sketchPending / refPlane 상태에 따라 후보 셋 / 우선순위가 달라짐. */
type PickMode = "normal" | "sketchPending" | "refPlaneFace" | "refPlaneEdge";

/** PreSelection Navigator — 마우스가 충분히 이동했다고 판단하는 NDC 거리. */
const HOVER_RESET_NDC = 0.005;
/** PreSelection Navigator — 마우스 정지 후 표시까지 대기 시간 (ms). */
const PRESELECTION_IDLE_DELAY = 500;

const determinePickMode = (
  sketchPending: boolean,
  refPlaneMode: RefPlaneCreationState | null,
): PickMode => {
  if (refPlaneMode?.step === "select-edge") return "refPlaneEdge";
  if (refPlaneMode?.step === "select-plane" && refPlaneMode.selectionMode === "face") return "refPlaneFace";
  if (sketchPending) return "sketchPending";
  return "normal";
};

/**
 * 단일 우선순위 정의로 hover / select 가 공유하는 3D pick 함수 (배열).
 * scene.pickEntities() 가 발행한 PickEntity 를 source + kind 별 우선순위로 재정렬,
 * origin / reference plane (PlaneHit) 은 plane picker 로 별도 수집해 끼워넣음.
 *
 * - normal: vertex → edge → originPlane → refPlane → face → volume
 *   (filter 별로 pickEntities 가 자체 게이팅 — 여기선 source/kind 만 분류)
 * - sketchPending / refPlaneFace: stepFace → sketchFace → refPlane → originPlane
 *   (face 진입 흐름이라 volume 은 후보에서 제외)
 * - refPlaneEdge: edge 만
 *
 * PreSelection Navigator 가 후보 ≥ 2 일 때 표시. Tab 으로 활성 인덱스 순환.
 */
const collect3DPickCandidates = (
  scene: SetupScene,
  ndc: THREE.Vector2,
  mode: PickMode,
  filter: SelectionFilterMode,
): Pick3DTarget[] => {
  const findEntity = (
    entities: PickEntity[],
    source: PickEntitySource,
    kind: PickEntityKind,
  ): PickEntity | undefined =>
    entities.find((e) => e.source === source && e.kind === kind);

  // 같은 (source, kind) 의 모든 entity — sketch face 처럼 겹치는 face 가 여러 개 있을 때
  // PreSelectionNav 가 분리 선택 가능하도록.
  const findAllEntities = (
    entities: PickEntity[],
    source: PickEntitySource,
    kind: PickEntityKind,
  ): PickEntity[] =>
    entities.filter((e) => e.source === source && e.kind === kind);

  if (mode === "refPlaneEdge") {
    const entities = scene.pickEntities(ndc, "edge");
    const edg = findEntity(entities, "step", "edge");
    return edg ? [edg] : [];
  }

  if (mode === "sketchPending" || mode === "refPlaneFace") {
    // face 진입 흐름 — filter 와 무관하게 face 후보만 모음. volume 은 제외.
    const entities = scene.pickEntities(ndc, "face");
    const candidates: Pick3DTarget[] = [];
    const stepFace = findEntity(entities, "step", "face");
    if (stepFace) candidates.push(stepFace);
    // 같은 sketch 안 여러 face (role-shape + 일반 closed loop) 겹치는 영역 — 모두 candidates.
    const sketchFaces = findAllEntities(entities, "sketch", "face");
    for (const sf of sketchFaces) candidates.push(sf);
    const refId = scene.pickReferencePlane(ndc);
    if (refId) candidates.push({ source: "referencePlane", id: refId });
    const originIdx = scene.pickOriginPlane(ndc);
    if (originIdx !== null) candidates.push({ source: "originPlane", index: originIdx });
    return candidates;
  }

  // normal mode — pickEntities 가 filter 별 후보를 발행.
  const entities = scene.pickEntities(ndc, filter);
  const candidates: Pick3DTarget[] = [];

  // 우선순위 — CATIA 표준 (점 → 선 → 면 → 그 외).
  // 같은 tier 안에서는 BRep step > sketch baked > plane auxiliary 순.

  // ── tier 1: 점 (vertex) ──
  const stepVtx = findEntity(entities, "step", "vertex");
  if (stepVtx) candidates.push(stepVtx);

  // ── tier 2: 선 (edge) — origin/reference plane 도 시각상 X/Y/Z axis line 이라 edge tier ──
  const stepEdg = findEntity(entities, "step", "edge");
  if (stepEdg) candidates.push(stepEdg);
  // origin / reference plane — 이름은 plane 이지만 시각상 axis line. edge tier 최하단.
  // filter "vertex" / "face" / "volume" 시 제외.
  if (filter === "all" || filter === "edge") {
    const originIdx = scene.pickOriginPlane(ndc);
    if (originIdx !== null) candidates.push({ source: "originPlane", index: originIdx });
    const refId = scene.pickReferencePlane(ndc);
    if (refId) candidates.push({ source: "referencePlane", id: refId });
  }

  // ── tier 3: 면 (face) ──
  const stepFace = findEntity(entities, "step", "face");
  if (stepFace) candidates.push(stepFace);
  // 같은 sketch 안 여러 face 겹칠 때 — 모두 candidates 에 (PreSelectionNav 분리 선택).
  const sketchFacesNormal = findAllEntities(entities, "sketch", "face");
  for (const sf of sketchFacesNormal) candidates.push(sf);

  // ── tier 4: 그 외 (volume) — solid body / extruded solid ──
  const stepVol = findEntity(entities, "step", "volume");
  if (stepVol) candidates.push(stepVol);
  const featVol = findEntity(entities, "feature", "volume");
  if (featVol) candidates.push(featVol);

  return candidates;
};

const collect3DPickCandidate = (
  scene: SetupScene,
  ndc: THREE.Vector2,
  mode: PickMode,
  filter: SelectionFilterMode,
): Pick3DTarget | null => {
  return collect3DPickCandidates(scene, ndc, mode, filter)[0] ?? null;
};

/** hit 의 kind 가 아닌 모든 highlight 를 해제. hover / select 양쪽 진입 시 호출. */
const clearAllHighlights = (scene: SetupScene, models: StepModelData[]): void => {
  scene.clearVertexHighlight();
  scene.clearEdgeHighlight();
  for (const model of models) scene.highlightFace(model.id, null);
  scene.hoverBody(null, null);
  scene.highlightOriginPlane(null);
  scene.highlightReferencePlane(null);
  // baked sketch face highlight 는 atom SSOT (inputBakedShape{Hovered,Selected}IdAtom) 가
  // 단독 관리 — onBakedShapeHover(null) 이 applyHighlight 의 sketch 아닌 분기에서 호출됨.
};

export type Use3DPickHandlerOptions = {
  onFacePick?: (result: FacePickResult) => void;
  onEdgePick?: (result: EdgePickResult) => void;
  onVertexPick?: (result: VertexPickResult) => void;
  /** Plane pick (origin / reference 통합). sketchPending / refPlaneMode 흐름에서 호출. */
  onPlanePick?: (hit: PlanePickHit) => void;
  onBakedSketchFacePick?: (result: BakedSketchFacePickResult) => void;
  onBodySelect?: (result: BodyPickResult | null) => void;
  onExtrudedSolidPick?: (result: ExtrudedSolidPickResult) => void;
  onBakedSketchFaceSelect?: (result: BakedSketchFacePickResult | null, additive?: boolean) => void;
  /** 통합 hover (origin plane / ref plane / extruded solid) — null = none. */
  onViewportHover?: (hit: ViewportHover | null) => void;
  /** 통합 select (origin plane / ref plane / extruded solid) — null = clear. */
  onViewportSelect?: (hit: ViewportHover | null) => void;
  /** PreSelection Navigator atom 갱신 (hover idle + 후보 ≥ 2 시 표시). */
  setPreSelectionNav?: (
    state: { candidates: PreSelectionCandidate[]; activeIndex: number; screenX: number; screenY: number } | null,
  ) => void;
  /** Baked sketch face (role 무관) hover/select — 부모가 atom set → SpecTree 와 sync. */
  onBakedShapeHover?: (id: string | null) => void;
  onBakedShapeSelect?: (id: string | null) => void;
};

export const use3DPickHandler = (
  scene: SetupScene | null,
  getNDC: (e: React.MouseEvent<HTMLCanvasElement>) => { x: number; y: number } | null,
  sketchPending: boolean,
  models: StepModelData[],
  selectionFilter: SelectionFilterMode,
  refPlaneMode: RefPlaneCreationState | null,
  /** sketch 모드 진입 여부 (`viewMode === "2d-section"`) — mode 전환 시 stale idle timer 정리. */
  isSketchActive: boolean,
  opts: Use3DPickHandlerOptions,
) => {
  const {
    onFacePick,
    onEdgePick,
    onVertexPick,
    onPlanePick,
    onBakedSketchFacePick,
    onBodySelect,
    onExtrudedSolidPick,
    onBakedSketchFaceSelect,
    onViewportHover,
    onViewportSelect,
    setPreSelectionNav,
    onBakedShapeHover,
    onBakedShapeSelect,
  } = opts;

  // 3D 모드 pointerdown NDC 위치 (클릭 vs 드래그 구분용)
  const pointerDownNDCRef = useRef<{ x: number; y: number } | null>(null);

  // CATIA PreSelection Navigator — Tab 순환 카운트 + 최근 후보 + 최근 마우스 위치.
  // sketch 의 useSketchPointerHandler 와 동일 패턴, 3D pick 후보 (Pick3DTarget) 대상.
  const tabSkipRef = useRef(0);
  const lastCandidatesRef = useRef<Pick3DTarget[]>([]);
  const lastScreenPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverPosRef = useRef<{ x: number; y: number } | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // Mode 변경 / sketch 진입 시 stale state 일괄 정리 — 이전 mode 의 후보 / Tab cycle /
  // hover 위치가 다음 mouse move 까지 잔존하면 그 사이 Tab / Enter 입력이 stale candidate
  // 에 적용됨. mouse move 발화 안 한 단축키 모드 전환 (sketchPending / refPlaneMode 토글
  // 등) 시 즉시 reset.
  useEffect(() => {
    tabSkipRef.current = 0;
    lastCandidatesRef.current = [];
    lastScreenPosRef.current = null;
    lastHoverPosRef.current = null;
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setPreSelectionNav?.(null);
  }, [isSketchActive, sketchPending, refPlaneMode, setPreSelectionNav]);

  // 클릭 핸들러 (ViewCube → sketchPending: collect 결과의 kind 별 분기)
  const handle3DClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!scene) return;

      // ViewCube 면 클릭 우선 처리
      if (scene.handleViewCubeClick(e.clientX, e.clientY)) return;

      const ndc = getNDC(e);
      if (!ndc) return;

      const ndcVec = new THREE.Vector2(ndc.x, ndc.y);

      const mode = determinePickMode(sketchPending, refPlaneMode);
      // normal / refPlaneEdge 는 pointerUp 에서 처리 (클릭 vs 드래그 구분)
      if (mode !== "sketchPending" && mode !== "refPlaneFace") return;

      const pick = collect3DPickCandidate(scene, ndcVec, mode, selectionFilter);
      if (!pick) return;

      // sketchPending / refPlaneFace 진입 흐름은 step.face / sketch.face / plane 만 처리.
      if (pick.source === "step" && pick.kind === "face") {
        onFacePick?.({ modelId: pick.modelId, faceGroupId: pick.faceGroupId, point: pick.worldPos });
      } else if (pick.source === "sketch") {
        onBakedSketchFacePick?.({ planeKey: pick.planeKey, planeName: pick.planeKey });
      } else if (pick.source === "referencePlane") {
        onPlanePick?.({ kind: "referencePlane", id: pick.id });
      } else if (pick.source === "originPlane") {
        onPlanePick?.({ kind: "originPlane", index: pick.index });
      }
    },
    [scene, getNDC, sketchPending, refPlaneMode, selectionFilter, onFacePick, onPlanePick, onBakedSketchFacePick],
  );

  // 3D 모드 pointerDown: NDC 기록
  const handle3DPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene) return;
      // 클릭 시점에 idle timer / 표시 중인 navigator 즉시 정리 — 500ms 안에 클릭이 일어나면
      // timer 가 뒤늦게 fire 해 contextMenu 를 덮어쓰는 케이스 방지.
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setPreSelectionNav?.(null);
      const ndc = getNDC(e);
      pointerDownNDCRef.current = ndc;
    },
    [scene, getNDC, setPreSelectionNav],
  );

  /**
   * 모든 selection SSOT 일괄 clear — 빈 공간 click 또는 mode 전환 시.
   * 새 selection atom 추가 시 이 helper 한 곳만 갱신하면 됨 (분기마다 반복할 필요 X).
   */
  const clearAllSelections = useCallback(() => {
    if (!scene) return;
    scene.deselectBody();
    scene.clearEdgeSelection();
    scene.clearVertexSelection();
    onBakedShapeSelect?.(null);
    onBodySelect?.(null);
    onBakedSketchFaceSelect?.(null, false);
    onViewportSelect?.(null);
  }, [scene, onBakedShapeSelect, onBodySelect, onBakedSketchFaceSelect, onViewportSelect]);

  /**
   * Pick3DTarget 의 source + kind 별 select 적용 — handle3DPointerUp (click) 과
   * confirm3DHoverCandidate (Enter) 가 공유. 이전엔 같은 switch 가 두 곳에 중복 작성되어
   * 새 source 추가 시 양쪽 동기화 필수였음. helper 추출로 단일 진입점.
   *
   * isMulti 는 ctrl/meta click 의 multi-select — Enter (confirm) 흐름에선 항상 false 전달.
   * step.volume 의 toggleBodySelection / sketch face 의 isMulti 인자에 영향.
   *
   * 분기 별 selection 패턴은 각 source 의 의도 보존 (단순 일괄 clearAllSelections 호출이
   * 아닌 — 예: step.face 는 BRep face 만 hover highlight 하고 다른 BRep selection (body 등)
   * 보존이 자연).
   */
  const applySelection = useCallback((pick: Pick3DTarget, isMulti: boolean) => {
    if (!scene) return;
    // PlaneHit 분기 (origin / reference plane)
    if (pick.source === "originPlane") {
      scene.deselectBody();
      scene.clearEdgeSelection();
      scene.clearVertexSelection();
      onViewportSelect?.({ kind: "originPlane", index: pick.index });
      onBakedSketchFaceSelect?.(null, false);
      return;
    }
    if (pick.source === "referencePlane") {
      scene.deselectBody();
      scene.clearEdgeSelection();
      scene.clearVertexSelection();
      onViewportSelect?.({ kind: "referencePlane", id: pick.id });
      onBakedSketchFaceSelect?.(null, false);
      return;
    }
    // PickEntity 분기 (source + kind)
    switch (pick.source) {
      case "step":
        switch (pick.kind) {
          case "vertex":
            scene.clearEdgeSelection();
            scene.selectVertex(pick.modelId, pick.bodyIndex, pick.vertexIndex);
            onVertexPick?.({ modelId: pick.modelId, bodyIndex: pick.bodyIndex, vertexIndex: pick.vertexIndex, point: { x: pick.worldPos.x, y: pick.worldPos.y, z: pick.worldPos.z } });
            return;
          case "edge":
            scene.clearVertexSelection();
            scene.selectEdge(pick.modelId, pick.bodyIndex, pick.edgeIndex);
            onEdgePick?.({ modelId: pick.modelId, bodyIndex: pick.bodyIndex, edgeIndex: pick.edgeIndex, point: { x: pick.worldPos.x, y: pick.worldPos.y, z: pick.worldPos.z } });
            onViewportSelect?.(null);
            return;
          case "face":
            // BRep face — face highlight 는 hover 단계에서 처리 (별도 select state 없음).
            // 다른 BRep selection (body 등) 은 보존 — face 클릭으로 의도치 않게 해제 X.
            return;
          case "volume":
            if (isMulti) scene.toggleBodySelection(pick.modelId, pick.bodyIndex);
            else scene.selectBody(pick.modelId, pick.bodyIndex);
            onBodySelect?.({ modelId: pick.modelId, bodyIndex: pick.bodyIndex });
            onBakedSketchFaceSelect?.(null, false);
            onViewportSelect?.(null);
            return;
        }
        return;
      case "feature":
        onExtrudedSolidPick?.({ operationId: pick.operationId });
        onViewportSelect?.({ kind: "solid", operationId: pick.operationId });
        onBakedSketchFaceSelect?.(null, false);
        return;
      case "sketch":
        scene.deselectBody();
        onBakedSketchFaceSelect?.({ planeKey: pick.planeKey, planeName: pick.planeKey, profileId: pick.profileId }, isMulti);
        // BakedShape selection atom 동기 (SSOT) — atom 변경 시 BakedSketchManager 가
        // mesh opacity 동기 (useEffect → scene.setBakedShapeSelected).
        onBakedShapeSelect?.(pick.shapeId ?? null);
        onViewportSelect?.(null);
        return;
    }
  }, [scene, onVertexPick, onEdgePick, onBodySelect, onExtrudedSolidPick, onBakedSketchFaceSelect, onBakedShapeSelect, onViewportSelect]);

  // 3D 모드 pointerUp: collect3DPickCandidate 결과의 kind 별 select 적용 (hover 와 동일 후보 함수)
  const handle3DPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene) return;

      const downNDC = pointerDownNDCRef.current;
      pointerDownNDCRef.current = null;
      const upNDC = getNDC(e);
      if (!upNDC) return;

      // 클릭 판정: 드래그 거리가 작으면 클릭
      const isClick = !downNDC || (upNDC.x - downNDC.x) ** 2 + (upNDC.y - downNDC.y) ** 2 <= 0.001;
      if (!isClick) return; // 오비트 드래그

      const ndcVec = new THREE.Vector2(upNDC.x, upNDC.y);
      const mode = determinePickMode(sketchPending, refPlaneMode);

      // refPlaneEdge 모드의 edge 선택은 handle3DClick 에서 처리됨 — pointerUp 에서는 무시.
      // sketchPending / refPlaneFace 모드의 plane / face 선택도 handle3DClick 에서 처리됨.
      if (mode !== "normal") {
        if (mode === "refPlaneEdge") {
          const pick = collect3DPickCandidate(scene, ndcVec, mode, selectionFilter);
          if (pick && pick.source === "step" && pick.kind === "edge") {
            onEdgePick?.({ modelId: pick.modelId, bodyIndex: pick.bodyIndex, edgeIndex: pick.edgeIndex, point: { x: pick.worldPos.x, y: pick.worldPos.y, z: pick.worldPos.z } });
          }
        }
        return;
      }

      const isMulti = e.ctrlKey || e.metaKey;
      // Tab 으로 PreSelection 활성 인덱스가 옮겨졌다면 그 후보를 click 시 선택 — sketch 와 동일.
      // mouse 가 충분히 이동했다면 handle3DPointerMove 의 moved 분기에서 tabSkipRef 가 이미 0.
      const candidates = collect3DPickCandidates(scene, ndcVec, mode, selectionFilter);
      const pick = candidates[tabSkipRef.current % Math.max(1, candidates.length)] ?? null;
      // 클릭 후엔 navigator 닫고 tabSkip 리셋.
      tabSkipRef.current = 0;
      setPreSelectionNav?.(null);

      if (!pick) {
        // 빈 공간 클릭 → 모든 선택 해제.
        clearAllSelections();
        return;
      }
      // source + kind 별 select 적용 — confirm3DHoverCandidate 와 helper 공유.
      applySelection(pick, isMulti);
    },
    [scene, getNDC, sketchPending, refPlaneMode, selectionFilter, onEdgePick, setPreSelectionNav, clearAllSelections, applySelection],
  );

  /** Pick3DTarget 의 source + kind 별 highlight 적용 — 매 hover 진입 시 호출. */
  const applyHighlight = useCallback((pick: Pick3DTarget | null) => {
    if (!scene) return;
    clearAllHighlights(scene, models);
    // sketch face hover 가 아니면 BakedShape hover atom clear (SSOT → SpecTree sync).
    const isSketchFace = pick?.source === "sketch" && pick.shapeId;
    if (!isSketchFace) onBakedShapeHover?.(null);
    if (!pick) {
      onViewportHover?.(null);
      return;
    }
    // PlaneHit 분기
    if (pick.source === "originPlane") {
      scene.highlightOriginPlane(pick.index);
      onViewportHover?.({ kind: "originPlane", index: pick.index });
      return;
    }
    if (pick.source === "referencePlane") {
      scene.highlightReferencePlane(pick.id);
      onViewportHover?.({ kind: "referencePlane", id: pick.id });
      return;
    }
    // PickEntity 분기 (source + kind)
    switch (pick.source) {
      case "step":
        switch (pick.kind) {
          case "vertex":
            scene.highlightVertex(pick.modelId, pick.bodyIndex, pick.vertexIndex);
            onViewportHover?.(null);
            return;
          case "edge":
            scene.highlightEdge(pick.modelId, pick.bodyIndex, pick.edgeIndex);
            onViewportHover?.(null);
            return;
          case "face":
            scene.highlightFace(pick.modelId, pick.faceGroupId);
            onViewportHover?.(null);
            return;
          case "volume":
            scene.hoverBody(pick.modelId, pick.bodyIndex);
            onViewportHover?.(null);
            return;
        }
        return;
      case "sketch":
        // BakedShape hover atom 동기 (SSOT) — atom 변경 시 BakedSketchManager 가 mesh
        // opacity 동기 (useEffect → scene.setBakedShapeHovered). atom 이 SSOT 라 SpecTree
        // entry 도 같이 강조.
        onBakedShapeHover?.(pick.shapeId ?? null);
        onViewportHover?.(null);
        return;
      case "feature":
        onViewportHover?.({ kind: "solid", operationId: pick.operationId });
        return;
    }
  }, [scene, models, onViewportHover, onBakedShapeHover]);

  // 3D 모드 pointerMove: collect3DPickCandidates 로 후보 수집 → tabSkipRef 인덱스의 후보를
  // highlight + idle (500ms) + 후보 ≥ 2 시 PreSelection Navigator 표시.
  const handle3DPointerMove = useCallback(
    (ndcVec: THREE.Vector2, screenPos?: { x: number; y: number }) => {
      if (!scene) return;

      const mode = determinePickMode(sketchPending, refPlaneMode);
      const candidates = collect3DPickCandidates(scene, ndcVec, mode, selectionFilter);

      // 마우스가 충분히 움직였으면 Tab 순환 카운트 리셋 + navigator 숨김.
      const lastPos = lastHoverPosRef.current;
      const moved = !lastPos || Math.hypot(ndcVec.x - lastPos.x, ndcVec.y - lastPos.y) > HOVER_RESET_NDC;
      if (moved) {
        tabSkipRef.current = 0;
        setPreSelectionNav?.(null);
      }
      lastHoverPosRef.current = { x: ndcVec.x, y: ndcVec.y };
      if (screenPos) lastScreenPosRef.current = screenPos;
      lastCandidatesRef.current = candidates;

      const pick = candidates[tabSkipRef.current % Math.max(1, candidates.length)] ?? null;
      applyHighlight(pick);

      // idle 타이머: 마우스 정지 + 후보 ≥ 2 면 navigator 표시.
      // 빠른 drag (pointerDown 직후 mouse 이동) 시 timer 가 fire 해 뒤늦게 뜨는 케이스 차단 —
      // pointerDownNDCRef 가 활성 (= 드래그 중) 이면 skip.
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (candidates.length >= 2 && setPreSelectionNav) {
        idleTimerRef.current = setTimeout(() => {
          if (pointerDownNDCRef.current) return;
          const sp = lastScreenPosRef.current;
          if (!sp) return;
          setPreSelectionNav({
            candidates: lastCandidatesRef.current.map((hit) => ({ source: "3d", hit })),
            activeIndex: tabSkipRef.current % Math.max(1, lastCandidatesRef.current.length),
            screenX: sp.x,
            screenY: sp.y,
          });
        }, PRESELECTION_IDLE_DELAY);
      }
    },
    [scene, sketchPending, refPlaneMode, selectionFilter, setPreSelectionNav, applyHighlight],
  );

  /**
   * CATIA PreSelection Navigator — Tab 으로 후보 순환 (3D).
   * lastCandidatesRef + tabSkipRef 갱신 + highlight 즉시 반영 + navigator 인덱스 갱신.
   */
  const cycle3DHoverCandidate = useCallback(() => {
    const candidates = lastCandidatesRef.current;
    if (candidates.length === 0) {
      tabSkipRef.current = 0;
      return;
    }
    tabSkipRef.current += 1;
    const next = candidates[tabSkipRef.current % candidates.length];
    applyHighlight(next);
    const sp = lastScreenPosRef.current;
    if (candidates.length >= 2 && setPreSelectionNav && sp) {
      setPreSelectionNav({
        candidates: candidates.map((hit) => ({ source: "3d", hit })),
        activeIndex: tabSkipRef.current % candidates.length,
        screenX: sp.x,
        screenY: sp.y,
      });
    }
  }, [applyHighlight, setPreSelectionNav]);

  /**
   * Enter 키로 활성 후보 confirm — 클릭과 동일한 select 동작.
   * Mode-aware: sketchPending / refPlaneFace 는 handle3DClick 의 분기 (onFacePick / onPlanePick /
   * onBakedSketchFacePick), normal 은 handle3DPointerUp 의 분기 (selection commit) 와 동일.
   */
  const confirm3DHoverCandidate = useCallback(() => {
    if (!scene) return;
    const candidates = lastCandidatesRef.current;
    if (candidates.length === 0) return;
    const pick = candidates[tabSkipRef.current % candidates.length];
    const mode = determinePickMode(sketchPending, refPlaneMode);

    // sketchPending / refPlaneFace 모드: face / plane 을 commit (sketch 진입 또는 refPlane base).
    if (mode === "sketchPending" || mode === "refPlaneFace") {
      if (pick.source === "step" && pick.kind === "face") {
        onFacePick?.({ modelId: pick.modelId, faceGroupId: pick.faceGroupId, point: pick.worldPos });
      } else if (pick.source === "sketch") {
        onBakedSketchFacePick?.({ planeKey: pick.planeKey, planeName: pick.planeKey });
      } else if (pick.source === "referencePlane") {
        onPlanePick?.({ kind: "referencePlane", id: pick.id });
      } else if (pick.source === "originPlane") {
        onPlanePick?.({ kind: "originPlane", index: pick.index });
      }
      tabSkipRef.current = 0;
      setPreSelectionNav?.(null);
      return;
    }

    // refPlaneEdge: edge 만 처리.
    if (mode === "refPlaneEdge") {
      if (pick.source === "step" && pick.kind === "edge") {
        onEdgePick?.({ modelId: pick.modelId, bodyIndex: pick.bodyIndex, edgeIndex: pick.edgeIndex, point: { x: pick.worldPos.x, y: pick.worldPos.y, z: pick.worldPos.z } });
      }
      tabSkipRef.current = 0;
      setPreSelectionNav?.(null);
      return;
    }

    // normal mode: handle3DPointerUp 의 select 로직 helper 공유 (multi-select 없음).
    // step.volume 의 toggleBodySelection / sketch face 의 isMulti 인자 모두 false.
    applySelection(pick, false);
    tabSkipRef.current = 0;
    setPreSelectionNav?.(null);
  }, [scene, sketchPending, refPlaneMode, onFacePick, onPlanePick, onBakedSketchFacePick, onEdgePick, setPreSelectionNav, applySelection]);

  return {
    handle3DClick,
    handle3DPointerDown,
    handle3DPointerUp,
    handle3DPointerMove,
    cycle3DHoverCandidate,
    confirm3DHoverCandidate,
  };
};
