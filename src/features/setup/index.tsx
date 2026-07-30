import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { contextMenuAtom } from "src/shared/stores/App.store";
import {
  fileDataAtomFamily,
  fileIdAtom,
} from "src/shared/stores/File.store";

import AnimateConstraintPanel from "./components/AnimateConstraintPanel";
import ConstraintDefinitionPanel from "./components/ConstraintDefinitionPanel";
import DimensionPanel from "./components/DimensionPanel";
import DrivenDimensionPrompt from "./components/DrivenDimensionPrompt";
import EditMultiConstraintPanel from "./components/EditMultiConstraintPanel";
import PadPocketPanel from "./components/PadPocketPanel";
import PlaneDefinitionPanel from "./components/PlaneDefinitionPanel";
import RevolvePanel from "./components/RevolvePanel";
import SetupCanvas from "./components/SetupCanvas";
import SetupCanvasInfoPanel from "./components/SetupCanvasInfoPanel";
import SketchFilletChamferPanel from "./components/SketchFilletChamferPanel";
import SketchTogglePanel from "./components/SketchTogglePanel";
import SketchToolsPanel from "./components/SketchToolsPanel";
import SpecTree from "./components/SpecTree";
import SetupToolbar from "./components/Toolbar";
import { CreatePadCommand } from "./core/commands/CreatePadCommand";
import { CreateRevolveCommand } from "./core/commands/CreateRevolveCommand";
import { DeleteBodyCommand } from "./core/commands/DeleteBodyCommand";
import { DeletePadCommand } from "./core/commands/DeletePadCommand";
import { DeleteSketchCommand } from "./core/commands/DeleteSketchCommand";
import { EditPadCommand } from "./core/commands/EditPadCommand";
import { ImportModelCommand } from "./core/commands/ImportModelCommand";
import { RemoveConstraintCommand } from "./core/commands/RemoveConstraintCommand";
import { RemoveModelCommand } from "./core/commands/RemoveModelCommand";
import {
  HideBodyCommand,
  HideModelCommand,
} from "./core/commands/VisibilityCommands";
import { useGlobalHistory } from "./hooks/useGlobalHistory";
import type SetupScene from "./rendering/SetupScene";
import {
  setupActiveSketchNameAtom,
  setupDefinitionShapeSelectedIdAtom,
  setupBakedSketchesAtom,
  setupChamferModeAtom,
  setupConstraintDialogOpenAtom,
  setupConstraintsAtom,
  setupFlushSyncAtom,
  setupPendingRestoreAtom,
  setupAtom,
  setupDimensionModeAtom,
  setupFilletModeAtom,
  setupDeletedBodiesAtom,
  setupHiddenBodiesAtom,
  setupHiddenModelsAtom,
  setupHiddenOperationsAtom,
  setupHiddenShapeIdsAtom,
  setupHiddenSketchPortionsAtom,
  setupHiddenSketchesAtom,
  setupModelsAtom,
  setupModelsRuntimeAtom,
  setupOperationsAtom,
  setupPadPocketModeAtom,
  setupReferencePlanesAtom,
  setupSelectedFacesAtom,
  setupOffsetModeAtom,
  setupSketchEntriesAtom,
  setup3DHoverAtom,
  setup3DSelectionAtom,
  setupViewModeAtom,
  resetInputUIAtoms,
  sketchCommandsAtom,
} from "./Setup.store";
import type {
  ConstraintTreeEntry,
  OperationTreeEntry,
  PadPocketDirection,
  PadPocketOperation,
  RevolveDirection,
  RevolveOperation,
  SetupData,
  SerializedGeometry,
  SerializedSketch,
  SketchTreeEntry,
  ViewportHoverItem,
} from "./Setup.type";
import { createRectangleGeometryAndConstraints } from "./sketch/commands/AddRectangleCommand";
import { InsertImageCommand } from "./sketch/commands/InsertImageCommand";
import type { SketchConstraint } from "./sketch/constraints/SketchConstraint.type";
import { loadStepFile } from "./step/StepLoader";
import { isNativeAvailable, loadStepFileNative } from "./step/StepLoaderNative";
import {
  buildConstraintContextMenuItems,
  buildModelContextMenuItems,
  buildOperationContextMenuItems,
  buildSketchContextMenuItems,
} from "./utils/contextMenuBuilders";
import {
  generateGeometryId,
  generateOperationId,
} from "./utils/idGenerator";
import { omitUndefined } from "./utils/objectUtils";
import {
  deserializeSetupData,
  deserializeStepModels,
} from "./utils/serialization";

/**
 * 마지막으로 hydrate 가 완료된 fileId — 모듈 레벨 보존.
 * 컴포넌트 useRef 와 달리 input 페이지 unmount → mount 사이에도 값 유지되어 같은 fileId
 * 로 재진입 시 fileId effect 본문이 다시 실행되지 않음 (engine / atom / viewMode reset
 * 같은 부수 효과 차단). 페이지 이동과 무관하게 영속 architecture 가 깨지지 않도록 보장.
 */
let _lastRestoredFileId: string | null = null;

// buildMaterialResolver 는 utils/buildMaterialResolver.ts 로 추출됨 — useLinkage3DBuild
// hook + 향후 다른 곳에서도 공유.

const Input = () => {
  const store = useStore();
  // setupAtom 직접 reactive subscribe 제거 — `input` 변수가 closure 안 (line ~392 의 file 전환
  // effect) 에서만 1회 read. reactive 불필요. useAtomValue 로 subscribe 하면 select 시 발생하는
  // 모든 dispatch atom mutate 마다 Input root (3000+ line) 전체 re-render → callback/useMemo
  // 재평가 → child component prop 재계산 → main thread 누적 비용 → freeze. store.get 으로
  // 변경해 subscribe 끊음 (file 전환 시점에 store 에서 최신 값 fetch).

  // 파일 전환 감지 (fileId 변화 시 atom 재복원)
  const fileId = useAtomValue(fileIdAtom);

  const closeSketchRef = useRef<() => void>(null);
  // 현재 활성 sketch 데이터를 baked 로 저장만 — close 부수 효과 없음
  const bakeCurrentSketchRef = useRef<(() => void) | null>(null);
  // 3D 모드 preset 적용 시 — XY plane sketch entry 생성용 ref.
  const bakeOriginXYRef = useRef<(() => void) | null>(null);
  const pickOriginPlaneRef = useRef<((planeIndex: number) => void) | null>(
    null,
  );
  const enterSketchByKeyRef = useRef<
    | ((
        planeKey: string,
        planeName: string,
        options?: { skipAnimation?: boolean },
      ) => void)
    | null
  >(null);
  const sceneRef = useRef<SetupScene | null>(null);
  // flushInputSync 는 아래에서 정의 — history listener 가 호출될 시점엔 ref 에 이미 채워져 있음
  // (history command 는 사용자 인터랙션 후 발생, 즉 첫 렌더 이후).
  const flushRef = useRef<(() => void) | null>(null);
  const {
    manager: globalHistory,
    undo: globalUndo,
    redo: globalRedo,
    executeCommand,
  } = useGlobalHistory(() => flushRef.current?.());

  const setInputData = useSetAtom(setupAtom);

  // 스케치 커맨드 콜백 (atom 기반 — ref prop drilling 대체)
  const sketchCommands = useAtomValue(sketchCommandsAtom);

  // SpecTree에서 기하/구속에 hover 중인지 여부 (캔버스 hover 업데이트 방지용)
  const sketchTreeHoveringRef = useRef(false);

  // 3D scene의 body hover/select 상태 → SpecTree 동기화용
  const [sceneHoveredBody, setSceneHoveredBody] = useState<{
    modelId: string;
    bodyIndex: number;
  } | null>(null);
  const [sceneSelectedBody, setSceneSelectedBody] = useState<{
    modelId: string;
    bodyIndex: number;
  } | null>(null);
  const [sceneSelectedBodies, setSceneSelectedBodies] = useState<
    { modelId: string; bodyIndex: number }[]
  >([]);

  const [models, setModels] = useAtom(setupModelsAtom);
  const [hiddenBodies, setHiddenBodies] = useAtom(setupHiddenBodiesAtom);
  const [, setDeletedBodies] = useAtom(setupDeletedBodiesAtom);
  const [hiddenModels, setHiddenModels] = useAtom(setupHiddenModelsAtom);
  const [sketchEntries, setSketchEntries] = useAtom(setupSketchEntriesAtom);
  const [operations, setOperations] = useAtom(setupOperationsAtom);
  const [, setConstraints] = useAtom(setupConstraintsAtom);
  const [padPocketMode, setPadPocketMode] = useAtom(setupPadPocketModeAtom);
  const [selectedFaces, setSelectedFaces] = useAtom(setupSelectedFacesAtom);
  const [revolveMode, setRevolveMode] = useState<{
    sketchPlaneKey: string;
    profileIds: string[];
  } | null>(null);
  const referencePlanes = useAtomValue(setupReferencePlanesAtom);
  const [dimensionMode, setDimensionMode] = useAtom(setupDimensionModeAtom);
  const [filletMode, setFilletMode] = useAtom(setupFilletModeAtom);
  const [chamferMode, setChamferMode] = useAtom(setupChamferModeAtom);
  const [offsetMode, setOffsetMode] = useAtom(setupOffsetModeAtom);
  const [, setContextMenu] = useAtom(contextMenuAtom);
  const viewMode = useAtomValue(setupViewModeAtom);

  // 파일 전환 시 UI 상태 격리 — atom은 Input.store의 레지스트리가 일괄 처리
  // 로컬 useState만 여기서 직접 초기화
  const resetUIState = useCallback(
    (SetupData: SetupData) => {
      resetInputUIAtoms(store, SetupData);

      // 로컬 useState 초기화 (컴포넌트 스코프)
      setRevolveMode(null);
      setSceneHoveredBody(null);
      setSceneSelectedBody(null);
      setSceneSelectedBodies([]);
      setAnimateConstraint(null);
      setEditMultiConstraint(false);
      setDrivenDimPrompt(null);
    },
    [store],
  );

  // 파일 전환 또는 최초 마운트 시 input 데이터 복원.
  // 모듈 레벨 단일 인스턴스 (engine, geoStore bundle) 패턴 — 인스턴스 dispose 안 하고
  // 데이터만 reset → 페이지 이동과 무관하게 인스턴스 영속, 같은 화면 보장.
  useEffect(() => {
    if (_lastRestoredFileId === fileId) return;
    const prevFileId = _lastRestoredFileId;
    _lastRestoredFileId = fileId;

    // 이전 파일을 떠나기 전 현재 상태 (camera + live sketch) 를 그 파일의 globalData 에 저장.
    // closeSketch 는 사용하지 않음 — 그건 setInputData 를 호출해 현재(=새) 파일에 viewMode="3d"
    // 를 쓰는 부작용. 대신 atomFamily 직접 접근으로 OLD 파일에만 명시 저장.
    const scene = sceneRef.current;
    if (prevFileId && scene) {
      // live sketch 가 있으면 bake (scene 의 BakedSketchManager 에 반영) 후 serialize.
      bakeCurrentSketchRef.current?.();
      const savedSketches: SerializedSketch[] = [];
      const bakedMgr = scene.getSavedSketches?.();
      if (bakedMgr) {
        for (const [, sketch] of bakedMgr) savedSketches.push(sketch);
      }
      const camState = scene.getCameraState();
      store.set(fileDataAtomFamily(prevFileId), (prev) => ({
        ...prev,
        globalData: {
          ...prev.globalData,
          setup: {
            ...prev.globalData.setup,
            cameraState: camState,
            // bake 결과가 있을 때만 sketches 덮어쓰기 (scene 미준비 보호).
            ...(savedSketches.length > 0 ? { sketches: savedSketches } : {}),
          },
        },
      }));
    }


    // 3D scene 초기화 — baked/solid/model/overlay geoStore + sketch plane mesh + origin
    // plane 가시성 reset. (이전엔 file switch effect 가 closeSketchRef 를 호출해 이 cleanup
    // 까지 했는데, closeSketch 가 setViewMode("3d") 로 새 파일 viewState 를 오염시키는
    // 문제 때문에 호출 제거 → scene cleanup 만 직접 수행.)
    if (scene) {
      scene.clearAllSketches();
      scene.clearSketchPlane();
      scene.setOriginPlanesVisible(true);
      scene.getGeometryOverlay()?.setExternalGeometries([]);
    }

    // baked atom reset (scene 의 BakedSketchManager 가 _notifyChange 로도 처리하지만 scene null 시 보강)
    store.set(setupBakedSketchesAtom, {});

    const SetupData = deserializeSetupData(store.get(setupAtom));

    // persisted atom 은 globalData.input의 derived atom이므로 별도 설정 불필요
    // (models, operations, referencePlanes, timelineScenes, generateOptions)
    // inputDefinitionRequestedAtom도 derived → globalData 전환으로 자동 반영됨

    // UI 전용 atom 일괄 초기화 (파일별로 격리)
    resetUIState(SetupData);

    // models 복원: SerializedStepModelData[] (globalData) → StepModelData[] (runtime atom).
    // base atom 만 set — globalData 는 disk format (= 이미 serialized) 그대로 유지.
    // setupModelsAtom setter 호출 시 globalData 까지 새 reference 갱신되어 originData 와
    // 잠시 reference 차이가 발생할 수 있으므로 base atom 직접 set 으로 회피.
    store.set(setupModelsRuntimeAtom, deserializeStepModels(SetupData.models));

    // 스케치/role/EE 복원은 scene이 필요 → pending atom에 저장하여 InputCanvas에서 소비.
    // sketches 가 비어있어도 viewState 가 sketch 모드면 plane 으로 자동 재진입 필요 (사용자가
    // sketch 진입 후 아무것도 안 그리고 파일 전환한 케이스).
    const needsRestore =
      SetupData.sketches.length > 0 ||
      (SetupData.viewState.mode === "2d-section" &&
        !!SetupData.viewState.sketchPlaneKey);
    if (needsRestore) {
      store.set(setupPendingRestoreAtom, SetupData);
    }

    // 카메라 상태 복원: SetupTransientState.cameraState (storage 별 독립 — DMU setup /
    // GD setupGen / result 각자 자기 카메라). disk 저장 X 라 앱 재시작 후 첫 진입은 null.
    if (scene) {
      const cs = store.get(setupAtom).cameraState ?? null;
      if (cs) scene.applyCameraState(cs);
      else scene.resetCamera();
    }

    // originData 동기화는 useFileActions 의 책임. 여기서 안 건드림.
    // input 후처리가 globalData mutation 안 하도록 transient atom 만 reset (derived atom
    // 은 globalData 가 file data 라 자동 반영).
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // input feature 상태 → globalData.input 동기화 함수.
  //
  // 시퀀스:
  //  1) bakeCurrentSketchRef.current?.() — 현재 활성 sketch 가 있으면 BakedSketchManager 에 commit.
  //  2) scene.getSavedSketches() 로 baked entries 수집.
  //  3) 활성 sketch 의 라이브 store (overlay) 가 있으면 그 geometry + constraints + shapes
  //     로 liveSketch 만들어 같은 planeKey 의 baked entry 를 교체.
  const flushInputSync = useCallback(() => {
    bakeCurrentSketchRef.current?.();

    // baked sketches를 가져와 직렬화
    const savedSketches: SerializedSketch[] = [];
    const scene = sceneRef.current;
    if (scene) {
      const bakedMgr = scene.getSavedSketches?.();
      if (bakedMgr) {
        for (const [, sketch] of bakedMgr) {
          savedSketches.push(sketch);
        }
      }
      // 스케치 편집 중이면 live 데이터도 직렬화 (bake 전이므로 savedSketches에 없음)
      const curVM = store.get(setupViewModeAtom);
      if (curVM === "2d-section") {
        const overlay = scene.getGeometryOverlay();
        const liveStore = overlay?.getStore();
        const livePlane = scene.getSketchPlane();
        const liveKey = scene.getPlaneKey(livePlane ?? undefined);
        if (liveStore && livePlane && liveKey) {
          const cStore = liveStore.constraintStore;
          const existIdx = savedSketches.findIndex((s) => {
            const k = scene.getPlaneKey(s.plane);
            return k === liveKey;
          });
          // undefined value key 회피 (isModified false positive 방지) — BakedSketchManager
          // bakeSketch 와 동일 패턴. 조건부 스프레드로만 키 추가.
          const liveName = store.get(setupActiveSketchNameAtom);
          const liveGeoms = liveStore.serialize();
          const liveConstraints = cStore?.serialize();
          const liveShapes = liveStore.shapes.map((sh) =>
            omitUndefined({ ...sh, holes: [] as [] }),
          );
          const liveSketch: SerializedSketch = { plane: livePlane };
          if (liveName) liveSketch.name = liveName;
          if (liveGeoms && liveGeoms.length > 0)
            liveSketch.geometries = liveGeoms;
          if (liveConstraints && liveConstraints.length > 0)
            liveSketch.constraints = liveConstraints;
          if (liveShapes.length > 0) liveSketch.shapes = liveShapes;
          if (existIdx >= 0) savedSketches[existIdx] = liveSketch;
          else savedSketches.push(liveSketch);
        }
      }
    }
    // 뷰 상태: mode/currentScene은 derived atom이 자동 반영.
    // sketchPlaneKey/Name은 imperative 값이므로 여기서 직렬화.
    const curVM = store.get(setupViewModeAtom);
    if (curVM === "2d-section" && scene) {
      const planeKey = scene.getPlaneKey();
      const activeSketchName = store.get(setupActiveSketchNameAtom);
      if (planeKey) {
        setInputData((prev) => ({
          ...prev,
          sketches: savedSketches,
          viewState: {
            ...prev.viewState,
            sketchPlaneKey: planeKey,
            sketchPlaneName: activeSketchName || planeKey,
          },
        }));
        return;
      }
    }

    // scene 이 null 이면 sketches 데이터를 가져올 수 없으므로 덮어쓰지 않음 (보존).
    // unmount cleanup 또는 ref 미준비 상태에서 빈 배열로 globalData 를 지우는 사고 방지.
    setInputData((prev) => ({
      ...prev,
      ...(scene ? { sketches: savedSketches } : {}),
    }));
  }, [setInputData, store]);

  // useGlobalHistory 의 onHistoryChange 콜백이 history 변경 (사용자 의도 단위) 마다 flush 트리거.
  // SpecTree / 3D scene 의 실시간 표시는 별도 listener (geometryStore.addRenderListener,
  // BakedSketchManager._onChange, _notifyChange 등) 로 처리되어 매 렌더 flush 불필요.
  // history listener 자동 flush 덕분에 globalData 가 항상 최신 → isModified 가 라이브 sketch
  // 변경에도 정확히 반응 → file actions 의 명시적 flush 불필요.
  flushRef.current = flushInputSync;
  useEffect(() => {
    const wrapper = () => flushRef.current?.();
    store.set(setupFlushSyncAtom, wrapper);
    return () => {
      store.set(setupFlushSyncAtom, null);
    };
  }, [store]);

  // 구속조건 애니메이션 다이얼로그 상태
  const [animateConstraint, setAnimateConstraint] = useState<{
    id: string;
    value: number;
  } | null>(null);

  // 다중 구속조건 편집 다이얼로그 상태
  const [editMultiConstraint, setEditMultiConstraint] = useState(false);
  // Constraint Definition Dialog (geometric constraint grid) 상태 — toolbar 토글 + atom 동기
  const [constraintDialogOpen, setConstraintDialogOpen] = useAtom(
    setupConstraintDialogOpenAtom,
  );

  // Driven dimension 프롬프트 상태 (over-constrained 시 참조 치수 확인)
  const [drivenDimPrompt, setDrivenDimPrompt] = useState<{
    callback: (asReference: boolean) => void;
  } | null>(null);

  // operations getter (스케치 닫을 때 rebuild용)
  const operationsRef = useRef(operations);
  operationsRef.current = operations;
  const getOperations = useCallback(() => operationsRef.current, []);

  // 기하 데이터 getter (커맨드에서 사용)
  const geometriesRef = useRef<Map<string, SerializedGeometry>>(new Map());
  const getGeometries = useCallback(() => geometriesRef.current, []);

  const handleCloseSketch = useCallback(() => {
    closeSketchRef.current?.();
  }, []);

  // STEP 파일 임포트 (글로벌 히스토리 커맨드)
  const loadingRef = useRef(false);
  const [importLoading, setImportLoading] = useState(false);
  const handleImportFile = useCallback(
    async (file: File) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setImportLoading(true);
      try {
        const buffer = await file.arrayBuffer();
        // 한 프레임 양보 — 로딩 UI가 렌더링된 후 파싱 실행
        await new Promise((r) => requestAnimationFrame(r));

        // Native Addon 우선, 실패 시 WASM 폴백
        let model;
        const nativeOk = await isNativeAvailable();
        if (nativeOk) {
          try {
            model = await loadStepFileNative(buffer, file.name);
          } catch (nativeErr) {
            console.error("[STEP] Native failed, WASM fallback:", nativeErr);
            model = await loadStepFile(buffer, file.name);
          }
        } else {
          model = await loadStepFile(buffer, file.name);
        }
        const getScene = () => sceneRef.current;
        executeCommand(new ImportModelCommand(model, setModels, getScene));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("STEP 파일 임포트 실패:", err);
      } finally {
        loadingRef.current = false;
        setImportLoading(false);
      }
    },
    [executeCommand, setModels],
  );

  // SpecTree hover 중 플래그 (3D pointerMove가 hover를 리셋하지 않도록)
  const treeHoveringRef = useRef(false);

  // scene 콜백: 매 렌더에서 최신 함수로 갱신 (stale closure 방지)
  {
    const s = sceneRef.current;
    if (s) {
      s.onBodyHoverChanged = (modelId, bodyIndex) => {
        // SpecTree hover 중이면 3D hover 콜백 무시 (충돌 방지)
        if (treeHoveringRef.current) return;
        const next =
          modelId !== null && bodyIndex !== null
            ? { modelId, bodyIndex }
            : null;
        setSceneHoveredBody((prev) => {
          if (
            prev?.modelId === next?.modelId &&
            prev?.bodyIndex === next?.bodyIndex
          )
            return prev;
          return next;
        });
      };
      s.onBodySelectChanged = (modelId, bodyIndex) => {
        setSceneSelectedBody(
          modelId !== null && bodyIndex !== null
            ? { modelId, bodyIndex }
            : null,
        );
        setSceneSelectedBodies([...(sceneRef.current?.selectedBodies ?? [])]);
      };
    }
  }

  // 바디 가시성 토글 (undo 가능)
  const handleBodyVisibilityToggle = useCallback(
    (modelId: string, bodyIndex: number, isHidden: boolean) => {
      executeCommand(
        new HideBodyCommand(
          modelId,
          bodyIndex,
          isHidden,
          setHiddenBodies,
          () => sceneRef.current,
        ),
      );
    },
    [executeCommand, setHiddenBodies],
  );

  // 모델 전체 가시성 토글 (undo 가능)
  const handleModelVisibilityToggle = useCallback(
    (modelId: string, isHidden: boolean) => {
      executeCommand(
        new HideModelCommand(
          modelId,
          isHidden,
          setHiddenModels,
          () => sceneRef.current,
        ),
      );
    },
    [executeCommand, setHiddenModels],
  );

  // 바디 하이라이트
  const handleBodyHover = useCallback(
    (modelId: string, bodyIndex: number | null) => {
      const isHover = bodyIndex !== null && bodyIndex >= 0;
      treeHoveringRef.current = isHover;
      const s = sceneRef.current;
      if (s) s.highlightBody(modelId, isHover ? bodyIndex : null);
      setSceneHoveredBody(isHover ? { modelId, bodyIndex } : null);
    },
    [setSceneHoveredBody],
  );

  // 바디 선택 (SpecTree Ctrl+클릭 대응)
  const handleBodySelect = useCallback(
    (modelId: string, bodyIndex: number, ctrlKey?: boolean) => {
      const s = sceneRef.current;
      if (!s) return;
      if (ctrlKey) {
        s.toggleBodySelection(modelId, bodyIndex);
      } else {
        s.selectBody(modelId, bodyIndex);
      }
    },
    [],
  );

  // 가시성 상태 getter (커맨드 캡처용)
  const hiddenBodiesRef = useRef(hiddenBodies);
  hiddenBodiesRef.current = hiddenBodies;
  const hiddenModelsRef = useRef(hiddenModels);
  hiddenModelsRef.current = hiddenModels;

  // 모델 우클릭 → "Delete Model" (글로벌 히스토리 커맨드)
  // 모델/바디 통합 컨텍스트 메뉴 (3D scene 우클릭 + SpecTree 우클릭 공용)
  const handleModelContextMenu = useCallback(
    (e: React.MouseEvent, modelId: string, bodyIndex?: number) => {
      const model = models.find((m) => m.id === modelId);
      const isHidden =
        bodyIndex != null
          ? (hiddenBodies?.get(modelId)?.has(bodyIndex) ?? false)
          : false;
      // 다중 선택 바디 목록
      const selectedBodies = sceneRef.current?.selectedBodies ?? [];

      const items = buildModelContextMenuItems({
        bodyIndex,
        isHidden,
        selectedBodiesCount: selectedBodies.length,
        onVisibilityToggle: () => {
          if (bodyIndex != null)
            handleBodyVisibilityToggle(modelId, bodyIndex, !isHidden);
        },
        onDelete: () => {
          if (bodyIndex != null) {
            executeCommand(
              new DeleteBodyCommand(
                modelId,
                bodyIndex,
                setDeletedBodies,
                setHiddenBodies,
                () => sceneRef.current,
              ),
            );
          } else {
            if (!model) return;
            const getScene = () => sceneRef.current;
            executeCommand(
              new RemoveModelCommand(
                model,
                setModels,
                getScene,
                setHiddenBodies,
                setHiddenModels,
                () => hiddenBodiesRef.current,
                () => hiddenModelsRef.current,
              ),
            );
          }
        },
      });
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items });
    },
    [
      models,
      setModels,
      setHiddenBodies,
      setDeletedBodies,
      setHiddenModels,
      executeCommand,
      setContextMenu,
      hiddenBodies,
      handleBodyVisibilityToggle,
    ],
  );

  // 스케치 bake 완료 → 엔트리 추가/갱신
  const handleSketchBaked = useCallback(
    (info: SketchTreeEntry) => {
      setSketchEntries((prev) => {
        const idx = prev.findIndex((e) => e.planeKey === info.planeKey);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = info;
          return next;
        }
        return [...prev, info];
      });
    },
    [setSketchEntries],
  );

  // 스케치 삭제 (글로벌 히스토리 커맨드)
  const handleSketchDelete = useCallback(
    (planeKey: string) => {
      const getScene = () => sceneRef.current;
      executeCommand(
        new DeleteSketchCommand(planeKey, setSketchEntries, getScene),
      );
    },
    [executeCommand, setSketchEntries],
  );

  // 스케치 가시성 토글 — SpecTree 의 onSketchVisibilityToggle 제거 (088 새 구조에서
  // sketch entry 의 visibility 가 portion only 로 일원화) → 미사용. BakedSketch group
  // 전체 visibility 가 필요하면 hiddenSketches atom watcher (line ~2800) 가 직접 처리.

  // Pad/Pocket 모드 시작
  const startPadPocket = useCallback(
    (type: "pad" | "pocket", planeKey: string) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const sketchData = scene.getSavedSketchByKey(planeKey);
      const geoms = sketchData?.geometries ?? [];
      const geoMap = new Map<string, SerializedGeometry>();
      for (const g of geoms) geoMap.set(g.id, g);
      geometriesRef.current = geoMap;

      // 우선순위 1) shape entry 가 SpecTree 또는 3D 에서 선택된 상태 → 그 shape 1 개만 profileId 로.
      // 우선순위 2) 기존 selectedFaces (sketchPending profile selection 흐름) — multi 가능.
      const selectedShapeId = store.get(setupDefinitionShapeSelectedIdAtom);
      let profileIds: string[] = [];
      const selectedShape = selectedShapeId
        ? sketchData?.shapes?.find((s) => s.id === selectedShapeId)
        : undefined;
      if (selectedShape) {
        profileIds = [selectedShape.id];
      } else {
        profileIds = selectedFaces
          .filter((f) => f.planeKey === planeKey && f.profileId)
          .map((f) => f.profileId!);
      }

      setPadPocketMode({
        type,
        sketchPlaneKey: planeKey,
        profileIds,
        depth: 20,
        direction: "normal",
      });
    },
    [store, selectedFaces, setPadPocketMode],
  );

  // Pad/Pocket 확인
  const handlePadPocketConfirm = useCallback(
    (
      depth: number,
      direction: PadPocketDirection,
      depth2?: number,
      draftAngle?: number,
    ) => {
      if (!padPocketMode) return;

      const scene = sceneRef.current;
      const entry = sketchEntries.find(
        (e) => e.planeKey === padPocketMode.sketchPlaneKey,
      );
      const planeName = entry?.planeName ?? padPocketMode.sketchPlaneKey;
      const geoSnapshot = new Map(geometriesRef.current);
      const getScene = () => sceneRef.current;

      if (padPocketMode.editingOperationId) {
        // 편집 모드: 기존 operation을 갱신
        const oldEntry = operations.find(
          (e) => e.operation.id === padPocketMode.editingOperationId,
        );
        if (
          !oldEntry ||
          (oldEntry.operation.type !== "pad" &&
            oldEntry.operation.type !== "pocket")
        ) {
          // operation이 삭제된 상태 → 편집 불가, 모드만 닫기
          setPadPocketMode(null);
          if (scene) scene.clearExtrudePreview();
          return;
        }
        const oldOp = oldEntry.operation as PadPocketOperation;
        const newOp: PadPocketOperation = {
          ...oldOp,
          depth,
          depth2,
          direction,
          draftAngle,
        };
        executeCommand(
          new EditPadCommand(
            oldOp,
            newOp,
            planeName,
            geoSnapshot,
            setOperations,
            getScene,
          ),
        );
      } else {
        // 신규 생성 모드
        // Pocket 은 본질적으로 빼기 연산 — 대상 솔리드가 필요 (마지막 visible).
        // Pad 는 default 독립 — 사용자가 새 Sketch 에 Pad 시 직전 Pad 와 합쳐지지 않음.
        // (이전엔 Pad 도 자동 타겟이라 두 Pad 가 CSG fuse 되어 한 mesh 안에 묻혀 직전 Pad 가
        //  안 보이는 문제 발생.)
        const targetOperationId =
          padPocketMode.type === "pocket"
            ? scene?.getLastVisibleSolidId()
            : undefined;

        if (padPocketMode.type === "pocket" && !targetOperationId) {
          setPadPocketMode(null);
          if (scene) scene.clearExtrudePreview();
          return;
        }

        // 각 profile의 lineIds를 캡처 (스케치 수정 시 rebuild 재매핑용)
        const sourceLineIds = padPocketMode.profileIds.map((pid) => {
          const geom = geoSnapshot.get(pid);
          return geom?.type === "polygon" ? geom.lineIds : [];
        });

        const op: PadPocketOperation = {
          id: generateOperationId(),
          type: padPocketMode.type,
          sketchPlaneKey: padPocketMode.sketchPlaneKey,
          profileIds: padPocketMode.profileIds,
          sourceLineIds,
          depth,
          depth2,
          direction,
          draftAngle,
          targetOperationId,
        };

        executeCommand(
          new CreatePadCommand(
            op,
            planeName,
            geoSnapshot,
            setOperations,
            getScene,
            (update) => store.set(setupHiddenShapeIdsAtom, update),
            () => store.get(setupHiddenShapeIdsAtom),
          ),
        );
      }

      setPadPocketMode(null);

      // 프리뷰 정리
      if (scene) scene.clearExtrudePreview();
    },
    [
      padPocketMode,
      sketchEntries,
      operations,
      executeCommand,
      setOperations,
      setPadPocketMode,
      store,
    ],
  );

  // Pad/Pocket 취소
  const handlePadPocketCancel = useCallback(() => {
    // 편집 모드였으면 임시 숨긴 솔리드 복원
    if (padPocketMode?.editingOperationId) {
      const scene = sceneRef.current;
      if (scene)
        scene.setExtrudedSolidVisible(padPocketMode.editingOperationId, true);
    }
    setPadPocketMode(null);
    const scene = sceneRef.current;
    if (scene) scene.clearExtrudePreview();
  }, [padPocketMode, setPadPocketMode]);

  // Revolve 모드 시작
  const startRevolve = useCallback((planeKey: string) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const sketchData = scene.getSavedSketchByKey(planeKey);
    const geoms = sketchData?.geometries ?? [];
    const geoMap = new Map<string, SerializedGeometry>();
    for (const g of geoms) geoMap.set(g.id, g);
    geometriesRef.current = geoMap;
    setRevolveMode({ sketchPlaneKey: planeKey, profileIds: [] });
  }, []);

  // Revolve 확인
  const handleRevolveConfirm = useCallback(
    (params: {
      angle: number;
      angle2?: number;
      axisType: "x" | "y" | "custom";
      axisOrigin?: { x: number; y: number };
      axisDirection?: { x: number; y: number };
      revolveDirection: RevolveDirection;
      clockwise: boolean;
    }) => {
      if (!revolveMode) return;
      const geoRef = geometriesRef.current;
      const sourceLineIds = revolveMode.profileIds.map((pid) => {
        const geom = geoRef.get(pid);
        return geom?.type === "polygon" ? geom.lineIds : [];
      });

      const op: RevolveOperation = {
        id: generateOperationId(),
        type: "revolve",
        sketchPlaneKey: revolveMode.sketchPlaneKey,
        profileIds: revolveMode.profileIds,
        sourceLineIds,
        angle: params.angle,
        angle2: params.angle2,
        axisType: params.axisType,
        axisOrigin: params.axisOrigin,
        axisDirection: params.axisDirection,
        revolveDirection: params.revolveDirection,
        clockwise: params.clockwise,
      };

      const entry = sketchEntries.find(
        (e) => e.planeKey === revolveMode.sketchPlaneKey,
      );
      const planeName = entry?.planeName ?? revolveMode.sketchPlaneKey;
      const geoSnapshot = new Map(geometriesRef.current);
      const getScene = () => sceneRef.current;

      executeCommand(
        new CreateRevolveCommand(
          op,
          planeName,
          geoSnapshot,
          setOperations,
          getScene,
        ),
      );
      setRevolveMode(null);

      const scene = sceneRef.current;
      if (scene) scene.clearExtrudePreview();
    },
    [revolveMode, sketchEntries, executeCommand, setOperations],
  );

  // Revolve 취소
  const handleRevolveCancel = useCallback(() => {
    setRevolveMode(null);
    const scene = sceneRef.current;
    if (scene) scene.clearExtrudePreview();
  }, []);

  // 작업 삭제 (삭제 시 기하 스냅샷 캡처하여 undo 가능하게)
  const handleDeleteOperation = useCallback(
    (operationId: string) => {
      const getScene = () => sceneRef.current;
      // 해당 operation의 소스 스케치에서 기하 데이터 추출
      const scene = sceneRef.current;
      let geoSnapshot = new Map<string, SerializedGeometry>();
      if (scene) {
        // operations atom에서 해당 operation 검색
        // (비동기 atom 접근 불가이므로 ref에서 현재 기하 사용)
        geoSnapshot = new Map(geometriesRef.current);
      }
      executeCommand(
        new DeletePadCommand(
          operationId,
          setOperations,
          getScene,
          geoSnapshot,
          (update) => store.set(setupHiddenShapeIdsAtom, update),
          () => store.get(setupHiddenShapeIdsAtom),
        ),
      );
    },
    [executeCommand, setOperations, store],
  );

  // 스케치 더블클릭 → 편집 모드 진입
  const handleSketchDoubleClick = useCallback((entry: SketchTreeEntry) => {
    const planeIndex = ["XY Plane", "YZ Plane", "ZX Plane"].indexOf(
      entry.planeName,
    );
    if (planeIndex >= 0) {
      pickOriginPlaneRef.current?.(planeIndex);
    } else {
      enterSketchByKeyRef.current?.(entry.planeKey, entry.planeName);
    }
  }, []);

  // Operation 더블클릭 → 편집 모드 진입
  const handleOperationDoubleClick = useCallback(
    (entry: OperationTreeEntry) => {
      const op = entry.operation;
      // Pad/Pocket만 편집 지원
      if (op.type !== "pad" && op.type !== "pocket") return;

      const scene = sceneRef.current;
      if (!scene) return;

      // 직전 edit 모드가 있었으면 그 솔리드 visibility 복원 — 다른 op 로 edit 전환 시
      // 이전 대상이 hidden 인 채 잔존하던 버그 fix. atom 직접 조회로 stale closure 회피.
      const prevMode = store.get(setupPadPocketModeAtom);
      if (
        prevMode?.editingOperationId &&
        prevMode.editingOperationId !== op.id
      ) {
        scene.setExtrudedSolidVisible(prevMode.editingOperationId, true);
        scene.clearExtrudePreview();
      }

      const sketchData = scene.getSavedSketchByKey(op.sketchPlaneKey);
      const geoms = sketchData?.geometries ?? [];
      const geoMap = new Map<string, SerializedGeometry>();
      for (const g of geoms) geoMap.set(g.id, g);
      geometriesRef.current = geoMap;

      // 편집 대상 솔리드를 임시 숨김 (프리뷰와 겹침 방지)
      scene.setExtrudedSolidVisible(op.id, false);

      setPadPocketMode({
        type: op.type,
        sketchPlaneKey: op.sketchPlaneKey,
        profileIds: op.profileIds,
        depth: op.depth,
        direction: op.direction,
        editingOperationId: op.id,
      });
    },
    [setPadPocketMode, store],
  );

  // 스케치 우클릭 → "Edit Sketch" / "Create Pad" / "Create Pocket" / "Delete Sketch"
  const handleSketchContextMenu = useCallback(
    (e: React.MouseEvent, entry: SketchTreeEntry) => {
      const items = buildSketchContextMenuItems({
        onEditSketch: () => handleSketchDoubleClick(entry),
        onCreatePad: () => startPadPocket("pad", entry.planeKey),
        onCreatePocket: () => startPadPocket("pocket", entry.planeKey),
        onCreateRevolve: () => startRevolve(entry.planeKey),
        onDeleteSketch: () => handleSketchDelete(entry.planeKey),
      });
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items });
    },
    [
      handleSketchDelete,
      handleSketchDoubleClick,
      startPadPocket,
      startRevolve,
      setContextMenu,
    ],
  );

  // 작업 우클릭 → Edit/Delete
  const handleOperationContextMenu = useCallback(
    (e: React.MouseEvent, entry: OperationTreeEntry) => {
      const items = buildOperationContextMenuItems({
        entry,
        onEdit: () => handleOperationDoubleClick(entry),
        onDelete: () => handleDeleteOperation(entry.operation.id),
      });
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items });
    },
    [
      handleDeleteOperation,
      handleOperationDoubleClick,
      setContextMenu,
    ],
  );

  // 구속조건 우클릭 → "Delete Constraint"
  const handleConstraintContextMenu = useCallback(
    (e: React.MouseEvent, entry: ConstraintTreeEntry) => {
      const items = buildConstraintContextMenuItems({
        onDelete: () =>
          executeCommand(
            new RemoveConstraintCommand(entry.constraint.id, setConstraints),
          ),
      });
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, items });
    },
    [executeCommand, setConstraints, setContextMenu],
  );

  // Dimension 패널 confirm — 구속 적용 후 패널만 닫음 (dimension 도구 모드 유지)
  const handleDimensionConfirm = useCallback(
    (value: number) => {
      if (!dimensionMode) return;
      sketchCommands.dimensionConfirm?.(dimensionMode.type, value);
      setDimensionMode(null);
    },
    [dimensionMode, setDimensionMode, sketchCommands],
  );

  // Dimension 패널 cancel
  const handleDimensionCancel = useCallback(() => {
    setDimensionMode(null);
  }, [setDimensionMode]);

  // 구속조건 애니메이션: 값 변경 핸들러
  const handleAnimateValueChange = useCallback(
    (constraintId: string, value: number) => {
      sketchCommands.constraintValueChange?.(constraintId, value);
    },
    [sketchCommands],
  );

  // 다중 구속 편집: 일괄 값 변경
  const handleMultiConstraintApply = useCallback(
    (changes: Map<string, number>) => {
      for (const [constraintId, value] of changes) {
        sketchCommands.constraintValueChange?.(constraintId, value);
      }
    },
    [sketchCommands],
  );

  // 스케치 Fillet confirm
  const handleSketchFilletConfirm = useCallback(
    (radius: number) => {
      sketchCommands.filletConfirm?.(radius);
    },
    [sketchCommands],
  );

  // 스케치 Fillet cancel
  const handleSketchFilletCancel = useCallback(() => {
    setFilletMode(null);
  }, [setFilletMode]);

  // 스케치 Fillet 프리뷰 (값 변경 시)
  const handleSketchFilletPreview = useCallback(
    (radius: number) => {
      sketchCommands.filletPreview?.(radius);
    },
    [sketchCommands],
  );

  // 스케치 Chamfer confirm
  const handleSketchChamferConfirm = useCallback(
    (distance: number, distance2?: number) => {
      sketchCommands.chamferConfirm?.(distance, distance2);
    },
    [sketchCommands],
  );

  // 스케치 Chamfer cancel
  const handleSketchChamferCancel = useCallback(() => {
    setChamferMode(null);
  }, [setChamferMode]);

  // 스케치 Chamfer 프리뷰 (값 변경 시)
  const handleSketchChamferPreview = useCallback(
    (distance: number, distance2?: number) => {
      sketchCommands.chamferPreview?.(distance, distance2);
    },
    [sketchCommands],
  );

  // 스케치 Offset confirm
  const handleSketchOffsetConfirm = useCallback(
    (distance: number) => {
      sketchCommands.offsetConfirm?.(distance);
    },
    [sketchCommands],
  );

  const handleSketchOffsetCancel = useCallback(() => {
    setOffsetMode(null);
  }, [setOffsetMode]);

  const handleSketchOffsetPreview = useCallback(
    (distance: number) => {
      sketchCommands.offsetPreview?.(distance);
    },
    [sketchCommands],
  );

  // Sketch Tools 입력 확정 → draw tool에 값 전달
  const handleSketchToolsConfirm = useCallback(
    (values: Partial<Record<string, number>>) => {
      // 도구별 applyInputValues 먼저 시도
      sketchCommands.sketchToolsApply?.(values);
    },
    [sketchCommands],
  );

  // 3D Edge Projection
  const handleProjectEdges = useCallback(() => {
    sketchCommands.projectEdges?.();
  }, [sketchCommands]);

  // 3D Silhouette Projection
  const handleProjectSilhouette = useCallback(() => {
    sketchCommands.projectSilhouette?.();
  }, [sketchCommands]);

  // 3D Intersect Elements
  const handleIntersect3D = useCallback(() => {
    sketchCommands.intersect3D?.();
  }, [sketchCommands]);

  // 이미지 파일 import — sketch 평면 위에 background 이미지 추가.
  // problem-definition 패턴: 4 line + 4 coincident + 2 horizontal + 2 vertical constraint
  // → 사각형 강체. 사용자가 vertex/line 드래그 시 이미지 함께 이동.
  const handleInsertImage = useCallback((file: File) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const overlay = scene.getGeometryOverlay();
    const geoStore = overlay?.getStore();
    if (!geoStore) return;

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      const img = new Image();
      img.src = result;
      img.onload = () => {
        const w = img.width;
        const h = img.height;
        // 1px = 1mm. 원점 중심 사각형.
        const x0 = -w / 2;
        const y0 = -h / 2;
        const lineIds: [string, string, string, string] = [
          generateGeometryId(),
          generateGeometryId(),
          generateGeometryId(),
          generateGeometryId(),
        ];
        const { geometries, constraints } =
          createRectangleGeometryAndConstraints(x0, y0, w, h, lineIds);
        // 4 line + 8 constraint + shape (image 속성) 을 atomic 추가 — ctrl+z 시 일괄 제거.
        geoStore.execute(
          new InsertImageCommand(lineIds, geometries, constraints, result),
        );
      };
    };
  }, []);


  // 3D에서 extruded solid 클릭 → operation 편집 패널 열기
  // 3D 솔리드 single click — no-op (CAD 관례: click 은 선택, edit 은 명시 메뉴/더블클릭).
  // 이전엔 click 이 곧 handleOperationDoubleClick → 대상 mesh 가 edit preview 위해 숨겨졌고,
  // 다른 pad 클릭 시 첫 번째 pad 가 hidden 상태로 잔존 → 사라진 것처럼 보이는 버그 발생.
  // edit 진입은 우클릭 → "Edit" 또는 SpecTree 더블클릭 사용.
  const handleExtrudedSolidPick = useCallback((_operationId: string) => {
    // 향후 selection highlight 추가 시 여기에 set selected solid id.
  }, []);

  // 3D에서 baked sketch face 클릭 → face 선택 (Pad/Pocket 대상, Ctrl+Click 멀티셀렉트)
  const handleBakedSketchFaceSelect = useCallback(
    (
      planeKey: string | null,
      planeName: string | null,
      profileId?: string | null,
      additive?: boolean,
    ) => {
      if (!planeKey) {
        setSelectedFaces([]);
        return;
      }
      const face = {
        planeKey,
        planeName: planeName ?? planeKey,
        profileId: profileId ?? null,
      };

      if (additive) {
        // shift-click: 토글 (이미 있으면 제거, 없으면 추가)
        // 같은 planeKey의 face만 멀티셀렉트 허용 (Pad/Pocket은 단일 평면 대상)
        setSelectedFaces((prev) => {
          const idx = prev.findIndex(
            (f) =>
              f.planeKey === face.planeKey && f.profileId === face.profileId,
          );
          if (idx >= 0) return prev.filter((_, i) => i !== idx);
          // 다른 planeKey의 기존 선택이 있으면 초기화 후 추가
          if (prev.length > 0 && prev[0].planeKey !== face.planeKey)
            return [face];
          return [...prev, face];
        });
      } else {
        // 일반 클릭: 단일 교체
        setSelectedFaces([face]);
      }
    },
    [setSelectedFaces],
  );

  // selectedFaces 변경 시 3D 하이라이트 동기화
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.highlightBakedSketchFaces(
      selectedFaces.map((f) => ({
        planeKey: f.planeKey,
        profileId: f.profileId,
      })),
    );
  }, [selectedFaces]);

  // 바디 우클릭 → "Hide"/"Show"

  const handleApplyConstraint = useCallback(
    (type: SketchConstraint["type"]) => sketchCommands.applyConstraint?.(type),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 기하 선택 (ctrlKey 지원)
  const handleSketchGeometrySelect = useCallback(
    (geomId: string, ctrlKey?: boolean) =>
      sketchCommands.selectGeometry?.(geomId, ctrlKey),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 구속조건 선택
  const handleSketchConstraintSelect = useCallback(
    (constraintId: string) => sketchCommands.selectConstraint?.(constraintId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 기하 삭제
  const handleSketchGeometryDelete = useCallback(
    (geomId: string) => sketchCommands.deleteGeometry?.(geomId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: construction 토글
  const handleSketchGeometryToggleConstruction = useCallback(
    (geomId: string) => sketchCommands.toggleConstruction?.(geomId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 기하 더블클릭 (선택 + 하이라이트)
  const handleSketchGeometryDoubleClick = useCallback(
    (geomId: string) => sketchCommands.selectGeometry?.(geomId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 구속조건 삭제
  const handleSketchConstraintDelete = useCallback(
    (constraintId: string) => sketchCommands.deleteConstraint?.(constraintId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 구속조건 더블클릭 (dimension 편집)
  const handleSketchConstraintDoubleClick = useCallback(
    (constraintId: string) =>
      sketchCommands.doubleClickConstraint?.(constraintId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: Rigid Group 이름 변경 (prompt로 입력)
  const handleSketchRigidGroupRename = useCallback(
    (constraintId: string, currentLabel: string | undefined) => {
      const input = window.prompt("Rename Rigid Group", currentLabel ?? "");
      if (input === null) return;
      sketchCommands.renameRigidGroup?.(constraintId, input);
    },
    [sketchCommands],
  );

  // SpecTree 스케치 모드: Rigid Group 해제
  const handleSketchRigidGroupDissolve = useCallback(
    (constraintId: string) => sketchCommands.dissolveRigidGroup?.(constraintId),
    [sketchCommands],
  );

  // SpecTree 스케치 모드: 기하 hover 시작/종료 (tree hovering 플래그 제어)
  const handleSketchGeometryHover = useCallback((geomId: string | null) => {
    sketchTreeHoveringRef.current = geomId !== null;
  }, []);

  // SpecTree 스케치 모드: 구속조건 hover 시작/종료 (tree hovering 플래그 제어)
  const handleSketchConstraintHover = useCallback(
    (constraintId: string | null) => {
      sketchTreeHoveringRef.current = constraintId !== null;
    },
    [],
  );

  const getScene = useCallback(() => sceneRef.current, []);

  // Reference planes → scene 동기화
  const prevRefPlaneIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const currentIds = new Set(referencePlanes.map((rp) => rp.id));
    // 삭제된 plane 제거
    for (const prevId of prevRefPlaneIdsRef.current) {
      if (!currentIds.has(prevId)) scene.removeReferencePlane(prevId);
    }
    // 새로 추가된 plane 생성
    for (const rp of referencePlanes) {
      if (!prevRefPlaneIdsRef.current.has(rp.id)) {
        scene.addReferencePlane(rp.id, rp.plane, rp.name);
      }
    }
    prevRefPlaneIdsRef.current = currentIds;
  }, [referencePlanes]);

  // Visibility atoms → scene 동기화. 사용자 토글 시점엔 command 가 atom + scene 둘 다 갱신하지만
  // 파일 전환 시엔 atom 만 새 파일 값으로 derive 되고 scene 은 직전 파일 상태 유지 → mismatch.
  // 이 effect 가 atom 변화 (toggle / file 전환 / model add) 마다 scene 에 일괄 적용.
  const hiddenSketches = useAtomValue(setupHiddenSketchesAtom);
  const hiddenOperations = useAtomValue(setupHiddenOperationsAtom);
  const hiddenShapeIds = useAtomValue(setupHiddenShapeIdsAtom);
  const hiddenSketchPortions = useAtomValue(setupHiddenSketchPortionsAtom);
  const setInput3DHover = useSetAtom(setup3DHoverAtom);
  const setInput3DSelectionAtom = useSetAtom(setup3DSelectionAtom);
  // 3D viewport pick (use3DPickHandler) 은 single hit | null 전달 — array atom 으로 adapt.
  const setInput3DSelection = useCallback(
    (hit: ViewportHoverItem | null) => {
      setInput3DSelectionAtom(hit === null ? [] : [hit]);
    },
    [setInput3DSelectionAtom],
  );
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const model of models) {
      const modelVisible = !hiddenModels.has(model.id);
      scene.setModelVisible(model.id, modelVisible);
      const hiddenSet = hiddenBodies.get(model.id);
      for (let i = 0; i < model.bodies.length; i++) {
        scene.setBodyVisible(model.id, i, !(hiddenSet?.has(i) ?? false));
      }
    }
  }, [models, hiddenBodies, hiddenModels]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // 모든 baked sketch 에 대해 적용 — scene 의 BakedSketchManager 가 planeKey 모름이라
    // hiddenSketches set 의 entries 직접 순회 + 누락된 plane (visible default) 처리.
    const savedSketches = scene.getSavedSketches?.();
    if (savedSketches) {
      for (const [planeKey] of savedSketches) {
        scene.setBakedSketchVisible(planeKey, !hiddenSketches.has(planeKey));
      }
    }
  }, [hiddenSketches]);

  // 개별 shape / Definition / Sketch sub-entry visibility — atom SSOT.
  useEffect(() => {
    sceneRef.current?.setHiddenShapeIds(hiddenShapeIds);
  }, [hiddenShapeIds]);
  useEffect(() => {
    sceneRef.current?.setHiddenSketchPortions(hiddenSketchPortions);
  }, [hiddenSketchPortions]);


  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const entry of operations) {
      scene.setExtrudedSolidVisible(
        entry.operation.id,
        !hiddenOperations.has(entry.operation.id),
      );
    }
  }, [operations, hiddenOperations]);

  // 3D viewport hover atom → scene hover state. SpecTree / viewport 양쪽 동일 path.
  // scene 측에서 hover/select state 분리 유지 → 둘 다 동시에 시각화 (서로 다른 색).
  const viewportHover = useAtomValue(setup3DHoverAtom);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (viewportHover?.kind === "originPlane") {
      scene.setOriginPlaneHover(viewportHover.index);
      scene.setReferencePlaneHover(null);
      scene.setSolidHovered(null);
    } else if (viewportHover?.kind === "referencePlane") {
      scene.setOriginPlaneHover(null);
      scene.setReferencePlaneHover(viewportHover.id);
      scene.setSolidHovered(null);
    } else if (viewportHover?.kind === "solid") {
      scene.setOriginPlaneHover(null);
      scene.setReferencePlaneHover(null);
      scene.setSolidHovered(viewportHover.operationId);
    } else {
      scene.setOriginPlaneHover(null);
      scene.setReferencePlaneHover(null);
      scene.setSolidHovered(null);
    }
  }, [viewportHover]);

  // 3D viewport selection atom → scene select state. hover 와 독립.
  const viewportSelection = useAtomValue(setup3DSelectionAtom);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const origin = viewportSelection.find((s) => s.kind === "originPlane");
    const refPlane = viewportSelection.find((s) => s.kind === "referencePlane");
    const solid = viewportSelection.find((s) => s.kind === "solid");
    scene.setOriginPlaneSelect(
      origin?.kind === "originPlane" ? origin.index : null,
    );
    scene.setReferencePlaneSelect(
      refPlane?.kind === "referencePlane" ? refPlane.id : null,
    );
    scene.setSolidSelected(solid?.kind === "solid" ? solid.operationId : null);
  }, [viewportSelection]);

  const handleOriginPlaneHover = useCallback(
    (i: number | null) => sceneRef.current?.highlightOriginPlane(i),
    [],
  );

  const handleOriginPlanePick = useCallback(
    (i: number) => pickOriginPlaneRef.current?.(i),
    [],
  );

  // 3D 모드 Delete 키: 선택된 body 삭제
  const handleDeleteSelectedBodies = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const b of scene.selectedBodies) {
      executeCommand(
        new DeleteBodyCommand(
          b.modelId,
          b.bodyIndex,
          setDeletedBodies,
          setHiddenBodies,
          () => sceneRef.current,
        ),
      );
    }
    scene.deselectBody();
  }, [executeCommand, setDeletedBodies, setHiddenBodies]);

  // 3D 모드 Delete 키: 선택된 operation 삭제 (selectedFaces 기반)
  const handleDeleteSelectedOperation = useCallback(() => {
    // 현재는 selectedFaces가 있으면 마지막 pad/pocket을 삭제
    // 향후 operation 선택 UI가 별도로 필요
  }, []);


  return (
    <div className="window-screen input">
      {importLoading && (
        <div className="input__loading-overlay">
          <div className="input__loading-spinner" />
          <span className="input__loading-text">Loading STEP file...</span>
        </div>
      )}
      <div className="input__shell">
        <div className="input__main">
          <SetupToolbar
            onCloseSketch={handleCloseSketch}
            onUndo={globalUndo}
            onRedo={globalRedo}
            onImportFile={handleImportFile}
            onStartPadPocket={startPadPocket}
            onStartRevolve={startRevolve}
            onProjectEdges={handleProjectEdges}
            onInsertImage={handleInsertImage}
            onProjectSilhouette={handleProjectSilhouette}
            onIntersect3D={handleIntersect3D}
          />
          <div className="input__content">
            <SetupCanvas
              closeSketchRef={closeSketchRef}
              bakeCurrentSketchRef={bakeCurrentSketchRef}
              bakeOriginXYRef={bakeOriginXYRef}
              pickOriginPlaneRef={pickOriginPlaneRef}
              enterSketchByKeyRef={enterSketchByKeyRef}
              sceneRef={sceneRef}
              onSketchBaked={handleSketchBaked}
              onModelContextMenu={handleModelContextMenu}
              onExtrudedSolidPick={handleExtrudedSolidPick}
              onViewportHover={setInput3DHover}
              onViewportSelect={setInput3DSelection}
              onBakedSketchFaceSelect={handleBakedSketchFaceSelect}
              onDeleteSelectedBodies={handleDeleteSelectedBodies}
              onDeleteSelectedOperation={handleDeleteSelectedOperation}
              globalHistory={globalHistory}
              getOperations={getOperations}
              sketchTreeHoveringRef={sketchTreeHoveringRef}
              onDrivenDimensionPrompt={(_constraint, callback) => {
                setDrivenDimPrompt({ callback });
              }}
            >
              <SetupCanvasInfoPanel />
            </SetupCanvas>
            <SketchToolsPanel
              getDrawTool={() => sketchCommands.getDrawTool?.()}
              onConfirm={handleSketchToolsConfirm}
            />
            {viewMode === "2d-section" && (
              <SketchTogglePanel
                getDrawTool={() => sketchCommands.getDrawTool?.()}
              />
            )}
            {filletMode && (
              <SketchFilletChamferPanel
                type="fillet"
                defaultValue={filletMode.defaultRadius}
                onConfirm={handleSketchFilletConfirm}
                onCancel={handleSketchFilletCancel}
                onValueChange={handleSketchFilletPreview}
              />
            )}
            {chamferMode && (
              <SketchFilletChamferPanel
                type="chamfer"
                defaultValue={chamferMode.defaultDistance}
                defaultValue2={chamferMode.defaultDistance2}
                chamferParamMode={chamferMode.paramMode}
                onConfirm={handleSketchChamferConfirm}
                onCancel={handleSketchChamferCancel}
                onValueChange={handleSketchChamferPreview}
              />
            )}
            {offsetMode && (
              <SketchFilletChamferPanel
                type="offset"
                defaultValue={offsetMode.defaultDistance}
                onConfirm={handleSketchOffsetConfirm}
                onCancel={handleSketchOffsetCancel}
                onValueChange={handleSketchOffsetPreview}
              />
            )}
            <DrivenDimensionPrompt
              visible={drivenDimPrompt !== null}
              onConfirm={() => {
                drivenDimPrompt?.callback(true);
                setDrivenDimPrompt(null);
              }}
              onCancel={() => {
                drivenDimPrompt?.callback(false);
                setDrivenDimPrompt(null);
              }}
            />
            {dimensionMode && (
              <DimensionPanel
                key={`${dimensionMode.type}-${dimensionMode.defaultValue}`}
                type={dimensionMode.type}
                defaultValue={dimensionMode.defaultValue}
                onConfirm={handleDimensionConfirm}
                onCancel={handleDimensionCancel}
              />
            )}
            {animateConstraint && (
              <AnimateConstraintPanel
                constraintId={animateConstraint.id}
                currentValue={animateConstraint.value}
                onValueChange={handleAnimateValueChange}
                onClose={() => setAnimateConstraint(null)}
              />
            )}
            {editMultiConstraint && (
              <EditMultiConstraintPanel
                constraints={
                  sketchCommands.getAnalysisData?.()?.constraints ?? new Map()
                }
                onApply={handleMultiConstraintApply}
                onClose={() => setEditMultiConstraint(false)}
              />
            )}
            {constraintDialogOpen && (
              <ConstraintDefinitionPanel
                onApplyConstraint={handleApplyConstraint}
                onClose={() => setConstraintDialogOpen(false)}
              />
            )}
            {padPocketMode && (
              <PadPocketPanel
                getScene={getScene}
                getGeometries={getGeometries}
                onConfirm={handlePadPocketConfirm}
                onCancel={handlePadPocketCancel}
              />
            )}
            <PlaneDefinitionPanel />
            {revolveMode && (
              <RevolvePanel
                sketchPlaneKey={revolveMode.sketchPlaneKey}
                profileIds={revolveMode.profileIds}
                getScene={getScene}
                getGeometries={getGeometries}
                onConfirm={handleRevolveConfirm}
                onCancel={handleRevolveCancel}
              />
            )}
            <SpecTree
              onOriginPlaneHover={handleOriginPlaneHover}
              onOriginPlanePick={handleOriginPlanePick}
              hiddenBodies={hiddenBodies}
              hiddenModels={hiddenModels}
              sketchEntries={sketchEntries}
              hoveredBody={sceneHoveredBody}
              selectedBody={sceneSelectedBody}
              selectedBodies={sceneSelectedBodies}
              onBodyVisibilityToggle={handleBodyVisibilityToggle}
              onModelVisibilityToggle={handleModelVisibilityToggle}
              onBodyHover={handleBodyHover}
              onModelHover={(modelId) => {
                const s = sceneRef.current;
                if (!s) return;
                // 모든 모델 하이라이트 해제 후 대상만 켜기
                for (const m of models) s.highlightModel(m.id, false);
                if (modelId) s.highlightModel(modelId, true);
              }}
              onModelSelect={(modelId) => {
                const s = sceneRef.current;
                if (!s) return;
                const model = models.find((m) => m.id === modelId);
                if (!model) return;
                s.deselectBody();
                for (let i = 0; i < model.bodies.length; i++) {
                  s.toggleBodySelection(modelId, i);
                }
              }}
              onBodySelect={handleBodySelect}
              onModelContextMenu={handleModelContextMenu}
              onBodyContextMenu={(e, modelId, bodyIndex, _isHidden) =>
                handleModelContextMenu(e, modelId, bodyIndex)
              }
              onSketchContextMenu={handleSketchContextMenu}
              onSketchDoubleClick={handleSketchDoubleClick}
              onOperationContextMenu={handleOperationContextMenu}
              onOperationDoubleClick={handleOperationDoubleClick}
              onConstraintContextMenu={handleConstraintContextMenu}
              onSketchGeometrySelect={handleSketchGeometrySelect}
              onSketchGeometryDelete={handleSketchGeometryDelete}
              onSketchGeometryToggleConstruction={
                handleSketchGeometryToggleConstruction
              }
              onSketchGeometryDoubleClick={handleSketchGeometryDoubleClick}
              onSketchGeometryHover={handleSketchGeometryHover}
              onSketchConstraintSelect={handleSketchConstraintSelect}
              onSketchConstraintDoubleClick={handleSketchConstraintDoubleClick}
              onSketchConstraintAnimate={(constraintId, currentValue) =>
                setAnimateConstraint({ id: constraintId, value: currentValue })
              }
              onSketchConstraintDelete={handleSketchConstraintDelete}
              onSketchConstraintHover={handleSketchConstraintHover}
              onSketchRigidGroupRename={handleSketchRigidGroupRename}
              onSketchRigidGroupDissolve={handleSketchRigidGroupDissolve}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Input;
