// 스케치 모드 포인터 핸들러: vertex/body 히트, 선택, DrawTool 라우팅, hover

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";

import { HIT_BUFFER } from "src/shared/constants/CanvasConstants";

import type { GeometryOverlayRenderer } from "../rendering/GeometryOverlayRenderer";
import type SetupScene from "../rendering/SetupScene";
import type { PreSelectionCandidate } from "../Setup.store";
import type { HitResult, SelectionFilterMode } from "../Setup.type";
import { getEffectiveLabelPos } from "../sketch/constraints/ConstraintValidator";
import { isReferenceId } from "../sketch/SketchGeometryStore";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import type { DrawTool } from "../sketch/tools/DrawTool";

/**
 * Sketch geometry 후보 + Constraint 후보를 통합한 정렬된 후보 배열.
 * 우선순위: 점 tier (REF_ORIGIN → 그 외 점/vertex) → constraint → 선 tier (axis → 그 외 line) → 면 tier.
 * select 흐름 (useSketchPointerHandler.handleSketchPointerDown) 과 일치.
 */
const collectAllHitCandidates = (
  store: SketchGeometryStore,
  overlay: GeometryOverlayRenderer | null,
  pos: { x: number; y: number },
  hitRadius: number,
  filter: SelectionFilterMode,
): HitResult[] => {
  // sketch 도메인은 'volume' 의미 없음 → 'all' 로 fallback. 3D filter 와 sketch filter 의
  // 의미 분리는 추후 sketch domain type 도입 시 정리 예정.
  const sketchFilter: "all" | "vertex" | "edge" | "face" = filter === "volume" ? "all" : filter;
  const split = store.hitTestSplit(pos, hitRadius, sketchFilter);
  // constraint는 selection filter "all"일 때만 포함 (vertex/edge/face 필터 시 제외)
  if (filter !== "all" || !overlay) {
    return [...split.point, ...split.edge, ...split.face];
  }
  const cs = overlay.hitTestConstraintCandidates(pos, hitRadius);
  const constraintHits: HitResult[] = cs.map((c) => ({
    kind: "constraint",
    distance: c.distance,
    constraintId: c.id,
  }));
  return [...split.point, ...constraintHits, ...split.edge, ...split.face];
};

import type { DragState } from "./useDragController";
import { computeEngineScale } from "./useInputSceneController";

export type UseSketchPointerHandlerOptions = {
  getDrawTool?: () => DrawTool | null;
  getGeometryStore?: () => SketchGeometryStore | null;
  /** Play / Manual 등 시뮬레이션 중 (= !== "idle") 이면 hover/select/drag hit-test 차단. */
  getIsPlaybackBlocked?: () => boolean;
  applySnap: (pos: { x: number; y: number }, geoStore: SketchGeometryStore | null, suppressSnap?: boolean) => { x: number; y: number };
  setSketchWorldPos: (pos: { x: number; y: number }) => void;
  getSnapInferenceRadius: () => number;
  dragRef: React.MutableRefObject<DragState | null>;
  /** SpecTree에서 기하/구속에 hover 중이면 true — 캔버스 pointerMove가 hover를 덮어쓰지 않도록 */
  sketchTreeHoveringRef?: React.MutableRefObject<boolean>;
  /** Linear actuator cylinder end 핸들 (throwDist 조절 drag handle) — 모든 actuator 의 핸들 위치 */
  getCylinderHandles?: () => Array<{ lineId: string; hx: number; hy: number; j1x: number; j1y: number; ux: number; uy: number; lineLen: number }>;
  /** Cylinder handle drag — 새 throwDist 적용 콜백 */
  onCylinderHandleDrag?: (lineId: string, newThrowDist: number) => void;
  /** 선택 필터 (vertex/edge/face/all) — hover/click hit test에 적용 (CATIA selection filter) */
  getSelectionFilter?: () => SelectionFilterMode;
  /** PreSelection Navigator atom 갱신 콜백 (hover idle 시 후보 목록 표시) */
  setPreSelectionNav?: (
    state: { candidates: PreSelectionCandidate[]; activeIndex: number; screenX: number; screenY: number } | null,
  ) => void;
  /** 빈 공간 클릭 시 callback — sketch geometry 외 atom selection (marker / linkage /
   * shape) 도 일괄 해제하기 위해 useInputSceneController 가 전달. */
  onEmptyClick?: () => void;
};

export const useSketchPointerHandler = (
  scene: SetupScene | null,
  getNDC: (e: React.MouseEvent<HTMLCanvasElement>) => { x: number; y: number } | null,
  opts: UseSketchPointerHandlerOptions,
) => {
  const {
    getDrawTool,
    getGeometryStore,
    getIsPlaybackBlocked,
    applySnap,
    setSketchWorldPos,
    getSnapInferenceRadius,
    dragRef,
    sketchTreeHoveringRef,
    getCylinderHandles,
    onCylinderHandleDrag,
    getSelectionFilter,
    setPreSelectionNav,
    onEmptyClick,
  } = opts;

  // Cylinder end handle 드래그 상태 — 활성 시 다른 hit test 모두 skip.
  const cylDragRef = useRef<{ lineId: string; j1x: number; j1y: number; ux: number; uy: number; lineLen: number } | null>(null);

  // unmount 시 idle 타이머 정리 (메모리 누수 방지)
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // CATIA PreSelection Navigator: 같은 위치에서 Tab 순환 시 사용
  const lastHoverPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastCandidatesRef = useRef<HitResult[]>([]);
  const lastScreenPosRef = useRef<{ x: number; y: number } | null>(null);
  const tabSkipRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // mouse 위치 차이가 이 값(world unit)을 넘으면 skip 카운트 리셋
  const HOVER_RESET_THRESHOLD = 1.0;
  // hover 정지 후 PreSelection Navigator 표시까지 대기 (ms)
  const PRESELECTION_IDLE_DELAY = 500;

  // 스케치 모드 pointerDown
  const handleSketchPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene) return;
      // Play / Manual 중엔 sketch 인터랙션 차단 (hit-test / select / drag 매 frame 부담 회피).
      if (getIsPlaybackBlocked?.()) return;

      // 클릭 시점에 idle timer / 표시 중인 navigator 즉시 정리 — 우/좌 어느 클릭이든
      // 500ms 안에 일어나면 timer 가 뒤늦게 fire 해 contextMenu 를 덮어쓰는 케이스 방지.
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setPreSelectionNav?.(null);

      // 우클릭: drawTool 체인 취소
      if (e.button === 2) {
        const drawTool = getDrawTool?.();
        const geoStore = getGeometryStore?.();
        if (drawTool && geoStore && drawTool.hasPendingWork()) {
          drawTool.cancel();
          geoStore.requestRender();
        }
        return;
      }
      if (e.button !== 0) return;

      const ndc = getNDC(e);
      if (!ndc) return;

      const ndcVec = new THREE.Vector2(ndc.x, ndc.y);
      const vec2 = scene.raycastSketchPlane(ndcVec);
      if (!vec2) return;

      // DrawTool 활성 시 기하 도구로 라우팅 (raw + snapped 좌표 모두 전달)
      const drawTool = getDrawTool?.();
      const geoStore = getGeometryStore?.();
      if (drawTool && geoStore) {
        const suppress = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
        const snapped = applySnap(vec2, geoStore, suppress);
        const scale = computeEngineScale(scene);
        drawTool.hitRadius = HIT_BUFFER / scale;
        drawTool.onPointerDown(geoStore, vec2, snapped, e.nativeEvent as PointerEvent);
        return;
      }

      // select 모드: vertex 히트 → 구속 히트 → 기하 히트 → shape 히트 (vertex 최우선)
      if (!drawTool && geoStore) {
        const scale = computeEngineScale(scene);
        const hitRadius = HIT_BUFFER / scale;

        // 0.5) Cylinder end handle 히트 (UI 핸들 — throwDist 조절)
        const cylHandles = getCylinderHandles?.();
        if (cylHandles && cylHandles.length > 0) {
          let bestHandle: typeof cylHandles[number] | null = null;
          let bestDist = Infinity;
          for (const h of cylHandles) {
            const d = Math.hypot(vec2.x - h.hx, vec2.y - h.hy);
            if (d < bestDist) {
              bestDist = d;
              bestHandle = h;
            }
          }
          if (bestHandle && bestDist <= hitRadius * 3) {
            cylDragRef.current = {
              lineId: bestHandle.lineId,
              j1x: bestHandle.j1x,
              j1y: bestHandle.j1y,
              ux: bestHandle.ux,
              uy: bestHandle.uy,
              lineLen: bestHandle.lineLen,
            };
            dragRef.current = null;
            return;
          }
        }

        // hover 와 동일한 collectAllHitCandidates 사용 — 단일 hit 함수, 동일 우선순위 (vertex
        // → constraint → geometry → face). Tab 으로 활성 인덱스가 옮겨졌다면 그 인덱스의 후보를
        // 선택 — hover/cycleHoverCandidate 와 동일 패턴. 이 동기화가 빠지면 navigator 가
        // 선을 가리켜도 클릭 시 항상 candidates[0] (= 점) 이 선택되는 버그.
        const filter = getSelectionFilter?.() ?? "all";
        const geoOverlay0 = scene.getGeometryOverlay();
        const candidates = collectAllHitCandidates(geoStore, geoOverlay0, vec2, hitRadius, filter);
        const pick = candidates[tabSkipRef.current % Math.max(1, candidates.length)] ?? null;
        const isAdditive = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;

        if (pick?.kind === "vertex") {
          // vertex hit — drag 가능. linkage / point / axis 는 hit candidates 단계에서 제외됨.
          // REF_ORIGIN / axis 는 _collectHitCandidatesSplit 에서 kind:"geometry" 로만 노출되므로
          // 이 분기엔 line/arc/curve 등 일반 geometry 의 endpoint vertex 만 진입.
          geoStore.selectedConstraintId = null;
          // 일반 vertex: dragRef 만 set. selection 적용은 handleDragEnd 가 담당 (drag 없으면 click 처리,
          // drag 면 handleDragMove 첫 프레임에서 set). pointerDown 에서 selection 을 직접 set 하면
          // handleDragEnd 의 toggle 이 그 선택을 즉시 풀어버려 mouseup 시 selection 해제로 보이는 문제 발생.
          dragRef.current = {
            isDragging: false,
            startPos: { x: vec2.x, y: vec2.y },
            lastPos: { x: vec2.x, y: vec2.y },
            ids: [pick.geomId],
            vertexHandle: { geomId: pick.geomId, vertexIndex: pick.vertexIndex, x: pick.x, y: pick.y },
            shapeId: null,
            geoSnapshot: null, fullSnapshot: null,
          };
          return;
        }

        if (pick?.kind === "constraint") {
          geoStore.selectedConstraintId = pick.constraintId;
          geoStore.selectedIds = [];
          geoStore.selectedVertices = [];
          geoStore.requestRender();
          const cst = geoStore.constraintStore?.constraints.get(pick.constraintId);
          const isDim = cst && "value" in cst;
          if (isDim) {
            const eff = getEffectiveLabelPos(cst, geoStore.geometries);
            const labelPos = eff ?? { x: vec2.x, y: vec2.y };
            dragRef.current = {
              isDragging: false,
              startPos: { x: vec2.x, y: vec2.y },
              lastPos: { x: vec2.x, y: vec2.y },
              ids: [],
              vertexHandle: null,
              shapeId: null,
              dimensionConstraintId: pick.constraintId,
              dimensionLabelStart: { x: labelPos.x, y: labelPos.y },
              geoSnapshot: null,
              fullSnapshot: null,
            };
          } else {
            dragRef.current = null;
          }
          return;
        }

        if (pick?.kind === "geometry") {
          const hitId = pick.geomId;
          const isRefHit = isReferenceId(hitId);
          geoStore.selectedConstraintId = null;
          if (geoStore.selectedIds.includes(hitId)) {
            if (isAdditive) {
              geoStore.selection = geoStore.selection.filter(
                (s) => !(s.kind === "geometry" && s.geomId === hitId),
              );
              geoStore.requestRender();
            }
          } else {
            if (isAdditive) {
              geoStore.selection = [...geoStore.selection, { kind: "geometry", geomId: hitId }];
            } else {
              geoStore.selection = [{ kind: "geometry", geomId: hitId }];
            }
            geoStore.requestRender();
          }
          dragRef.current = isRefHit ? null : {
            isDragging: false,
            startPos: { x: vec2.x, y: vec2.y },
            lastPos: { x: vec2.x, y: vec2.y },
            // 원점·축 같은 참조 기하는 선택에 남아 있어도 드래그 대상이 아니다. 여기서 빼야 이동뿐 아니라
            // 단일 원 크기 조절 판정(ids.length === 1)·fixedKeys 같은 drag.ids 소비처가 모두 참조 기하를 세지 않는다.
            ids: geoStore.selectedIds.filter((id) => !isReferenceId(id)),
            vertexHandle: null,
            shapeId: null,
            geoSnapshot: null, fullSnapshot: null,
          };
          return;
        }

        if (pick?.kind === "face") {
          const faceHitId = pick.faceId;
          const shape = geoStore.shapes.find((s) => s.id === faceHitId);
          geoStore.selectedConstraintId = null;
          const alreadySelected = geoStore.selection.some((s) => s.kind === "face" && s.faceId === faceHitId);
          if (alreadySelected) {
            if (isAdditive) {
              geoStore.selection = geoStore.selection.filter(
                (s) => !(s.kind === "face" && s.faceId === faceHitId),
              );
            }
          } else {
            if (isAdditive) {
              geoStore.selection = [...geoStore.selection, { kind: "face", faceId: faceHitId }];
            } else {
              geoStore.selection = [{ kind: "face", faceId: faceHitId }];
            }
          }
          geoStore.requestRender();
          if (shape) {
            dragRef.current = {
              isDragging: false,
              startPos: { x: vec2.x, y: vec2.y },
              lastPos: { x: vec2.x, y: vec2.y },
              ids: [...shape.lineIds],
              vertexHandle: null,
              shapeId: shape.id,
              geoSnapshot: null, fullSnapshot: null,
            };
          } else {
            dragRef.current = null;
          }
          return;
        }

        // 빈 공간 클릭 → 선택 해제 + 박스 선택 시작
        if (geoStore.selection.length > 0 || geoStore.selectedConstraintId) {
          geoStore.selection = [];
          geoStore.selectedConstraintId = null;
          geoStore.requestRender();
        }
        // marker / linkage / shape 등 atom 기반 selection 도 일괄 해제.
        onEmptyClick?.();
        dragRef.current = {
          isDragging: false,
          startPos: { x: vec2.x, y: vec2.y },
          lastPos: { x: vec2.x, y: vec2.y },
          ids: [],
          vertexHandle: null,
          shapeId: null,
          geoSnapshot: null, fullSnapshot: null,
        };
        return;
      }
    },
    [scene, getNDC, getDrawTool, getGeometryStore, getIsPlaybackBlocked, applySnap, dragRef, getCylinderHandles, getSelectionFilter, setPreSelectionNav, onEmptyClick],
  );

  // 스케치 모드 pointerUp
  const handleSketchPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!scene || e.button !== 0) return;

      const ndc = getNDC(e);
      if (!ndc) return;

      const ndcVec = new THREE.Vector2(ndc.x, ndc.y);
      const vec2 = scene.raycastSketchPlane(ndcVec);
      if (!vec2) return;

      // Cylinder end handle 드래그 종료
      if (cylDragRef.current) {
        cylDragRef.current = null;
        return;
      }

      // DrawTool 활성 시 기하 도구로 라우팅 (raw + snapped 좌표 모두 전달)
      const drawTool = getDrawTool?.();
      const geoStore = getGeometryStore?.();
      if (drawTool && geoStore) {
        const suppress = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
        const snapped = applySnap(vec2, geoStore, suppress);
        drawTool.onPointerUp(geoStore, vec2, snapped, e.nativeEvent as PointerEvent);
        return;
      }

    },
    [scene, getNDC, getDrawTool, getGeometryStore, applySnap],
  );

  // 스케치 모드 pointerMove
  const handleSketchPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, handleDragMove: (vec2: { x: number; y: number }) => boolean) => {
      if (!scene) return;
      // Play / Manual 중엔 hover hit-test / drag 차단 — 매 frame 작업 부담 회피.
      if (getIsPlaybackBlocked?.()) return;

      const ndc = getNDC(e);
      if (!ndc) return;

      const ndcVec = new THREE.Vector2(ndc.x, ndc.y);
      const vec2 = scene.raycastSketchPlane(ndcVec);
      if (!vec2) return;

      // DrawTool 활성 시 기하 도구로 라우팅 (raw + snapped 좌표 모두 전달)
      const drawTool = getDrawTool?.();
      const geoStore = getGeometryStore?.();
      if (drawTool && geoStore) {
        const suppress = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
        drawTool.inferenceRadius = getSnapInferenceRadius();
        drawTool.hitRadius = HIT_BUFFER / computeEngineScale(scene);
        const snapped = applySnap(vec2, geoStore, suppress);
        drawTool.onPointerMove(geoStore, vec2, snapped, e.nativeEvent as PointerEvent);
        // crosshair 위치 업데이트 (snapped 좌표 사용)
        scene.getGeometryOverlay()?.setPointerPosition(snapped);
        // Sketch Tools 패널 좌표 업데이트
        setSketchWorldPos({ x: snapped.x, y: snapped.y });
        return;
      }

      // select 모드: crosshair 해제
      scene.getGeometryOverlay()?.setPointerPosition(null);
      // Sketch Tools 패널 좌표 업데이트 (select 모드에서도)
      setSketchWorldPos({ x: vec2.x, y: vec2.y });

      // Cylinder end handle 드래그 중 — 포인터의 axis projection 으로 새 throwDist 계산.
      if (cylDragRef.current) {
        const { lineId, j1x, j1y, ux, uy, lineLen } = cylDragRef.current;
        const proj = (vec2.x - j1x) * ux + (vec2.y - j1y) * uy;
        const newThrow = Math.max(0.001, Math.min(proj, lineLen));
        onCylinderHandleDrag?.(lineId, newThrow);
        return;
      }

      // select 모드: 드래그 이동 또는 기하 호버
      const drag = dragRef.current;
      if (drag) {
        if (handleDragMove(vec2)) return;
      }

      // 비 드래그: vertex hover → 기하 호버 + 엔진 전달
      const selectStore = getGeometryStore?.();
      if (selectStore) {
        const scale = computeEngineScale(scene);
        const hitRadius = HIT_BUFFER / scale;

        // SpecTree에서 hover 중이면 캔버스 hover 업데이트 스킵 (tree hover 우선)
        const treeHovering = sketchTreeHoveringRef?.current ?? false;

        if (!treeHovering) {
          // 마우스가 충분히 이동했으면 Tab 순환 카운트 리셋 + PreSelection Navigator 숨김
          const lastPos = lastHoverPosRef.current;
          const moved = !lastPos || Math.hypot(vec2.x - lastPos.x, vec2.y - lastPos.y) > HOVER_RESET_THRESHOLD;
          if (moved) {
            tabSkipRef.current = 0;
            setPreSelectionNav?.(null);
          }
          lastHoverPosRef.current = { x: vec2.x, y: vec2.y };
          lastScreenPosRef.current = { x: e.clientX, y: e.clientY };

          // CATIA PreSelection 우선순위 + selection filter + Tab 순환 (constraint 통합)
          const filter = getSelectionFilter?.() ?? "all";
          const geoOverlay = scene.getGeometryOverlay();
          const candidates = collectAllHitCandidates(selectStore, geoOverlay, vec2, hitRadius, filter);
          lastCandidatesRef.current = candidates;
          const pick = candidates[tabSkipRef.current % Math.max(1, candidates.length)] ?? null;

          // idle 타이머: 마우스 정지 + 후보 2개 이상이면 PreSelection Navigator 표시.
          // 빠른 mousedown→drag 시점에 timer 가 fire 해 navigator 가 뒤늦게 뜨는 케이스 — drag 활성
          // (dragRef.current 또는 EE/cylinder drag) 이면 skip.
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          if (candidates.length >= 2 && setPreSelectionNav) {
            idleTimerRef.current = setTimeout(() => {
              if (dragRef.current || cylDragRef.current) return;
              const sp = lastScreenPosRef.current;
              if (!sp) return;
              setPreSelectionNav({
                candidates: lastCandidatesRef.current.map((hit) => ({ source: "sketch", hit })),
                activeIndex: tabSkipRef.current % Math.max(1, lastCandidatesRef.current.length),
                screenX: sp.x,
                screenY: sp.y,
              });
            }, PRESELECTION_IDLE_DELAY);
          }

          // 통합 hit 결과 hover 적용
          if (pick?.kind === "constraint") {
            selectStore.hoveredItem = { kind: "constraint", constraintId: pick.constraintId };
            geoOverlay?.updateConstraintHover(vec2, hitRadius);
          } else if (pick?.kind === "vertex") {
            selectStore.hoveredItem = { kind: "vertex", geomId: pick.geomId, vertexIndex: pick.vertexIndex, x: pick.x, y: pick.y };
            geoOverlay?.updateConstraintHover(null, hitRadius);
          } else if (pick?.kind === "geometry") {
            selectStore.hoveredItem = { kind: "geometry", geomId: pick.geomId };
            geoOverlay?.updateConstraintHover(null, hitRadius);
          } else if (pick?.kind === "face") {
            selectStore.hoveredItem = { kind: "face", faceId: pick.faceId };
            geoOverlay?.updateConstraintHover(null, hitRadius);
          } else {
            selectStore.hoveredItem = null;
            geoOverlay?.updateConstraintHover(null, hitRadius);
          }

          selectStore.snapResult = null;
          selectStore.requestRender();
        }
      }

    },
    [scene, getNDC, getDrawTool, getGeometryStore, getIsPlaybackBlocked, applySnap, setSketchWorldPos, getSnapInferenceRadius, dragRef, sketchTreeHoveringRef, onCylinderHandleDrag, getSelectionFilter, setPreSelectionNav],
  );

  /**
   * CATIA PreSelection Navigator: Tab 키 등으로 같은 위치 다음 후보로 hover 전환.
   * 마지막 hover 위치에서 통합 후보(constraint + sketch)를 재계산하여 skipCount++로 다음 항목 선택.
   */
  const cycleHoverCandidate = useCallback(() => {
    if (!scene) return;
    const pos = lastHoverPosRef.current;
    if (!pos) return;
    const selectStore = getGeometryStore?.();
    if (!selectStore) return;
    tabSkipRef.current += 1;
    const scale = computeEngineScale(scene);
    const hitRadius = HIT_BUFFER / scale;
    const filter = getSelectionFilter?.() ?? "all";
    const geoOverlay = scene.getGeometryOverlay();
    const candidates = collectAllHitCandidates(selectStore, geoOverlay, pos, hitRadius, filter);
    if (candidates.length === 0) {
      tabSkipRef.current = 0;
      return;
    }
    const next = candidates[tabSkipRef.current % candidates.length];
    if (next.kind === "constraint") {
      selectStore.hoveredItem = { kind: "constraint", constraintId: next.constraintId };
      geoOverlay?.updateConstraintHover(pos, hitRadius);
    } else if (next.kind === "vertex") {
      selectStore.hoveredItem = { kind: "vertex", geomId: next.geomId, vertexIndex: next.vertexIndex, x: next.x, y: next.y };
      geoOverlay?.updateConstraintHover(null, hitRadius);
    } else if (next.kind === "geometry") {
      selectStore.hoveredItem = { kind: "geometry", geomId: next.geomId };
      geoOverlay?.updateConstraintHover(null, hitRadius);
    } else if (next.kind === "face") {
      selectStore.hoveredItem = { kind: "face", faceId: next.faceId };
      geoOverlay?.updateConstraintHover(null, hitRadius);
    }
    // PreSelection Navigator 활성 인덱스 갱신 (이미 표시 중이면 즉시 반영)
    const sp = lastScreenPosRef.current;
    if (candidates.length >= 2 && setPreSelectionNav && sp) {
      setPreSelectionNav({
        candidates: candidates.map((hit) => ({ source: "sketch", hit })),
        activeIndex: tabSkipRef.current % candidates.length,
        screenX: sp.x,
        screenY: sp.y,
      });
    }
    selectStore.requestRender();
  }, [scene, getGeometryStore, getSelectionFilter, setPreSelectionNav]);

  /**
   * CATIA PreSelection Navigator — Enter 키로 활성 후보 confirm.
   * cycleHoverCandidate 가 갱신해 둔 tabSkipRef + lastCandidatesRef 의 활성 후보를
   * 즉시 selection 에 적용. drag 동작은 없으니 단순 click 효과만.
   */
  const confirmHoverCandidate = useCallback(() => {
    const candidates = lastCandidatesRef.current;
    if (candidates.length === 0) return;
    const selectStore = getGeometryStore?.();
    if (!selectStore) return;
    const pick = candidates[tabSkipRef.current % candidates.length];

    if (pick.kind === "vertex") {
      selectStore.selectedConstraintId = null;
      selectStore.selection = [
        { kind: "vertex", geomId: pick.geomId, vertexIndex: pick.vertexIndex, x: pick.x, y: pick.y },
      ];
    } else if (pick.kind === "constraint") {
      selectStore.selectedConstraintId = pick.constraintId;
      selectStore.selection = [];
    } else if (pick.kind === "geometry") {
      selectStore.selectedConstraintId = null;
      selectStore.selection = [{ kind: "geometry", geomId: pick.geomId }];
    } else if (pick.kind === "face") {
      selectStore.selectedConstraintId = null;
      selectStore.selection = [{ kind: "face", faceId: pick.faceId }];
    }

    tabSkipRef.current = 0;
    setPreSelectionNav?.(null);
    selectStore.requestRender();
  }, [getGeometryStore, setPreSelectionNav]);

  return {
    handleSketchPointerDown,
    handleSketchPointerUp,
    handleSketchPointerMove,
    cycleHoverCandidate,
    confirmHoverCandidate,
  };
};
