import { atom, type createStore, type Getter } from "jotai";
import { selectAtom } from "jotai/utils";

import { globalDataAtom } from "src/shared/stores/File.store";

import { planeKeyFromSketchPlane } from "./rendering/SketchPlaneManager";
import type {
  ChamferModeState,
  ConnectContinuity,
  ConstraintTreeEntry,
  DimensionModeState,
  FilletModeState,
  HoverItem,
  SetupData,
  OffsetModeState,
  OperationTreeEntry,
  PadPocketModeState,
  ReferencePlane,
  ReferenceProfile,
  ProfileMode,
  RefPlaneCreationState,
  SelectedSketchFace,
  SelectionFilterMode,
  SelectionPropertyInfo,
  SerializedSketch,
  SketchCommands,
  SketchConstraintTreeItem,
  SketchDrawToolType,
  SketchGeometryTreeItem,
  SketchPlane,
  SketchShapeTreeItem,
  SnapDisplayInfo,
  SketchTreeEntry,
  StepModelData,
  ViewportHoverItem,
  // Phase: store 에서 type.ts 로 이동한 type 들 (cycle 회피 + 일관성).
  GeometryStoreBundle,
  PreSelectionNavState,
} from "./Setup.type";
import {
  EMPTY_CONSTRAINT_APPLICABILITY,
  type ConstraintApplicability,
} from "./sketch/constraints/ConstraintValidator";
import type { SolveStatus } from "./sketch/constraints/SketchConstraint.type";
import { SketchConstraintSolver } from "./sketch/constraints/SketchConstraintSolver";
import { SketchConstraintStore } from "./sketch/constraints/SketchConstraintStore";
import { SketchGeometryStore } from "./sketch/SketchGeometryStore";
import { serializeStepModels } from "./utils/serialization";

// 타입 재노출 (기존 소비처 호환성 유지)
export type {
  ChamferModeState,
  ChamferParamInputMode,
  ChamferParamMode,
  DimensionModeState,
  FilletChamferTrimMode,
  FilletModeState,
  OffsetModeState,
  PadPocketModeState,
  ProfileMode,
  RefPlaneCreationState,
  SelectedSketchFace,
  SketchCommands,
  SnapDisplayInfo,
  // Phase: store 에서 type.ts 로 이동한 type re-export.
  AssemblyRenderMode,
  GeometryStoreBundle,
  PreSelectionCandidate,
  PreSelectionNavState,
} from "./Setup.type";

// setup 스토어 — globalDataAtom.setup storage dispatch atom.
// type: SetupData (= SetupPersistentData + 메모리 전용 필드 cameraState 등).
//
// 디스크 저장 시 ExtractDataUtils.extractSetupPersistentData 로 메모리 필드 제거.
export const setupAtom = atom(
  (get) => get(globalDataAtom).setup,
  (get, set, update: SetupData | ((prev: SetupData) => SetupData)) => {
    const gd = get(globalDataAtom);
    const prev: SetupData | null = gd.setup;
    if (prev === null) return; // 아직 초기화 전 — type narrowing.
    const next = typeof update === "function" ? update(prev) : update;
    // Same-field skip — dispatch atom 에 callback `(p) => ({...p, field: value})` 로 same
    // value 로 호출돼도 spread 로 새 object 생겨 setupAtom value 의 ref 변경. 이 케이스에서
    // globalDataAtom mutate 방지 — 안 그러면 idempotent setter (예: setSelectedIds([...same])
    // 로 syncState fire 될 때 array but same content) 가 fileData mutate → isModifiedAtomFamily
    // deep compare + 100+ subscriber invalidate → cycle → freeze.
    //
    // array field 는 element-wise compare (primitive element 는 ref/value 동일) — 새 array
    // 라도 element 같으면 skip. object element 까지 deep compare 는 비용 큼.
    if (next === prev) return;
    const prevKeys = Object.keys(prev) as Array<keyof SetupData>;
    const nextKeys = Object.keys(next) as Array<keyof SetupData>;
    if (prevKeys.length === nextKeys.length) {
      let changed = false;
      for (const k of prevKeys) {
        const pv = prev[k];
        const nv = next[k];
        if (pv === nv) continue;
        // 새 array 라도 element 가 모두 same 이면 idempotent → skip.
        if (Array.isArray(pv) && Array.isArray(nv)) {
          if (pv.length === nv.length && pv.every((v, i) => v === nv[i])) continue;
        }
        changed = true;
        break;
      }
      if (!changed) return;
    }
    set(globalDataAtom, { ...gd, setup: next });
  },
);

/**
 * Helper factory — setup 의 sub-group (panelOpen | visibility) 한 field 를
 * read/write derived atom 으로 노출. callback updater + same-value skip + nested spread.
 * mode 별 sub-group 분리 후 atom 정의 단순화 — 다수 atom 의 boilerplate 감소.
 */
function setupGroupFieldAtom<
  G extends "panelOpen" | "visibility",
  K extends keyof SetupData[G],
>(group: G, field: K) {
  type V = SetupData[G][K];
  return atom(
    (get) => (get(setupAtom)[group] as SetupData[G])[field],
    (get, set, value: V | ((prev: V) => V)) =>
      set(setupAtom, (p) => {
        const groupObj = p[group] as SetupData[G];
        const prev = groupObj[field];
        const next = typeof value === "function" ? (value as (prev: V) => V)(prev) : value;
        return {
          ...p,
          [group]: { ...groupObj, [field]: next },
        };
      }),
  );
}

// Runtime form (positions/normals = number[]) — base atom. globalData 와 별도.
// file load 시점에 이 atom 에 set (globalData 의 disk format = serialized 그대로). user
// mutation (STEP import / delete) 시점에 setupModelsAtom 의 setter 로 함께 sync.
export const setupModelsRuntimeAtom = atom<StepModelData[]>([]);

export const setupModelsAtom = atom(
  (get) => get(setupModelsRuntimeAtom),
  (
    get,
    set,
    update: StepModelData[] | ((prev: StepModelData[]) => StepModelData[]),
  ) => {
    const prev = get(setupModelsRuntimeAtom);
    const models = typeof update === "function" ? update(prev) : update;
    set(setupModelsRuntimeAtom, models);
    // globalData 직렬화 — serialized form. nativeShapeHandle 등 transient 필드 제외.
    set(setupAtom, (p) => ({ ...p, models: serializeStepModels(models) }));
  },
);

// 뷰 모드 (3D perspective / 2D 단면도) — viewState.mode 에서 파생
export const setupViewModeAtom = atom(
  (get) => get(setupAtom).viewState.mode,
  (get, set, mode: "3d" | "2d-section") => {
    set(setupAtom, (p) => ({ ...p, viewState: { ...p.viewState, mode } }));
  },
);

/**
 * sketch 진입 시 활성 plane key (read-only derived) — primitive string. 매번 새 ref
 * 생성 안 되게 — SpecTree 등 consumer 가 useAtomValue(setupAtom).viewState.sketchPlaneKey
 * 로 직접 read 대신 이 atom 을 subscribe 하면 setupAtom 전체 mutate 시 re-render 안 함.
 * value 변경 (sketchPlaneKey 자체 변경) 시에만 invalidate.
 */
export const setupSketchPlaneKeyAtom = atom(
  (get) => get(setupAtom).viewState.sketchPlaneKey,
);

/**
 * Sketch 모드 진입 — viewState.mode + sketchPlaneKey + sketchPlaneName 함께 업데이트.
 * 항상 함께 호출되어야 모드 전환 시 plane 정보가 어긋나지 않음.
 *
 * faceSource: STEP body face 에서 진입한 경우 (modelId + faceGroupId) — 종료 시
 * applyCrossSection 등에 쓰는 plane 참조.
 */
export const enterSketchModeAtom = atom(
  null,
  (
    get,
    set,
    info: {
      planeKey: string;
      planeName: string;
      faceSource?: { modelId: string; faceGroupId: number };
    },
  ) => {
    // 이 파일의 히스토리에 지금 열린 스케치를 알림 — 다른 스케치의 기하 엔트리는 undo/redo 하지 않는다.
    get(setupAtom).globalHistory.setActiveSketch(info.planeKey);
    set(setupAtom, (p) => ({
      ...p,
      viewState: {
        ...p.viewState,
        mode: "2d-section",
        sketchPlaneKey: info.planeKey,
        sketchPlaneName: info.planeName,
        // info.faceSource 가 undefined 면 key 자체를 안 추가. lodash isEqual 은 { x: undefined }
        // 와 missing key 를 다르게 봐 isModified 오탐 (originData 엔 key 없음).
        ...(info.faceSource !== undefined
          ? { sketchFaceSource: info.faceSource }
          : {}),
      },
    }));
  },
);

/** Sketch 모드 종료 — mode="3d" + sketch 관련 key 삭제 (undefined 대신 key 자체 제거). */
export const exitSketchModeAtom = atom(null, (get, set) => {
  get(setupAtom).globalHistory.setActiveSketch(null);
  set(setupAtom, (p) => {
    // sketchPlaneKey / sketchPlaneName / sketchFaceSource 를 undefined 로 set 하면 viewState
    // 자체에 key 가 추가됨 (값은 undefined). originData 와 shape mismatch → isModified 오탐.
    // optional 필드는 destructure 로 제거.
    const {
      sketchPlaneKey: _spk,
      sketchPlaneName: _spn,
      sketchFaceSource: _sfs,
      ...restView
    } = p.viewState;
    return {
      ...p,
      viewState: { ...restView, mode: "3d" },
    };
  });
});

// 참조 프로파일 목록
export const setupProfilesAtom = atom<ReferenceProfile[]>([]);

// 3D 선택 필터 모드 (face/edge/vertex/all)
export const setupSelectionFilterAtom = atom(
  (get) => get(setupAtom).selectionFilter,
  (get, set, value: SelectionFilterMode) =>
    set(setupAtom, (p) => ({ ...p, selectionFilter: value })),
);

// Reference Plane 목록 (globalData.input.referencePlanes 의 derived atom)
export const setupReferencePlanesAtom = atom(
  (get) => get(setupAtom).referencePlanes,
  (
    get,
    set,
    update: ReferencePlane[] | ((prev: ReferencePlane[]) => ReferencePlane[]),
  ) => {
    const prev = get(setupAtom).referencePlanes;
    const referencePlanes =
      typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({ ...p, referencePlanes }));
  },
);

/**
 * 참조 평면 목록을 next 로 바꿔 놓아도 되는지 — 평면 생성·삭제의 undo/redo 판정 (useHistoricalAtom 의 canApply).
 * 지금 있는 평면 중 next 에서 빠지는 것을 스케치(열린 것·저장된 것)나 연산이 쓰고 있으면 false — 지우면 그 스케치가
 * 기준 평면을 잃는다. 이때 히스토리는 그 엔트리 앞에서 멈춘다(스케치 경계 정책과 같음). 평면과 스케치·연산은
 * planeKey(origin+normal)로 이어진다.
 */
export function canSetReferencePlanes(next: ReferencePlane[], get: Getter): boolean {
  const kept = new Set(next.map((p) => p.id));
  const removed = get(setupReferencePlanesAtom).filter((p) => !kept.has(p.id));
  if (removed.length === 0) return true;
  const setup = get(setupAtom);
  const used = new Set<string>();
  if (setup.viewState.sketchPlaneKey) used.add(setup.viewState.sketchPlaneKey);
  for (const sketch of setup.sketches) used.add(planeKeyFromSketchPlane(sketch.plane));
  for (const key of Object.keys(get(setupBakedSketchesAtom))) used.add(key);
  for (const entry of get(setupSketchEntriesAtom)) used.add(entry.planeKey);
  for (const entry of get(setupOperationsAtom)) used.add(entry.operation.sketchPlaneKey);
  return !removed.some((p) => used.has(planeKeyFromSketchPlane(p.plane)));
}

// Reference plane 생성 중 mode / 미리보기 / sketch plane / 평면 선택 상태 — **standalone**
// (생성 중 임시 상태, 임시 UI — mode 스코프 불필요).
export const setupRefPlaneModeAtom = atom<RefPlaneCreationState | null>(
  null as RefPlaneCreationState | null,
);
export const setupRefPlanePreviewAtom = atom<SketchPlane | null>(
  null as SketchPlane | null,
);
export const setupSketchPlaneAtom = atom<SketchPlane | null>(
  null as SketchPlane | null,
);

// 평면 선택 대기 상태 (Sketch 버튼 클릭 후 평면 클릭 전) — **standalone**.
export const setupSketchPlaneSelectionPendingAtom = atom<boolean>(false);

// 스케치 요소 선택 상태 — **standalone atom** (mode 스코프 불필요 — 임시 UI. drag 시 매 mouse
// move 마다 mutate 되면 dispatch 경유 시 globalData chain 비용 커져 freeze 위험).
export const setupSketchSelectedIdsAtom = atom<string[]>([]);

// 요소 hover (선/vertex/원/face) — **standalone atom**.
export const setupSketchHoveredItemAtom = atom<HoverItem | null>(
  null as HoverItem | null,
);

// 구속 선택 (캔버스 / SpecTree) — **standalone atom**.
export const setupSketchSelectedConstraintIdAtom = atom<string | null>(
  null as string | null,
);

// --- Visibility atoms — SetupPersistentData.visibility 의 derived atom (per-file 저장) ---
// 디스크 저장은 Record/array 형태, runtime 은 Map/Set 으로 변환해서 노출 (기존 caller 호환).
//
// selectAtom 으로 sub-field 만 구독 — setupAtom 의 visibility 외 다른 (예: viewState) 이
// 변경돼도 재계산 안 됨. Map/Set 인스턴스는 source record 가 변경될 때만 갱신.

type HiddenBodiesMap = Map<string, Set<number>>;

function recordToMap(rec: Record<string, number[]>): HiddenBodiesMap {
  const map: HiddenBodiesMap = new Map();
  for (const [k, arr] of Object.entries(rec)) map.set(k, new Set(arr));
  return map;
}

function mapToRecord(map: HiddenBodiesMap): Record<string, number[]> {
  const rec: Record<string, number[]> = {};
  for (const [k, s] of map) rec[k] = Array.from(s);
  return rec;
}

// 각 visibility sub-field 의 selectAtom — 해당 sub-field reference 가 바뀔 때만 fire.
const hiddenBodiesRecordAtom = selectAtom(setupAtom, (i) => i.visibility.hiddenBodies);
const deletedBodiesRecordAtom = selectAtom(setupAtom, (i) => i.visibility.deletedBodies);
const hiddenModelsArrayAtom = selectAtom(setupAtom, (i) => i.visibility.hiddenModels);
const hiddenSketchesArrayAtom = selectAtom(setupAtom, (i) => i.visibility.hiddenSketches);
const hiddenOperationsArrayAtom = selectAtom(setupAtom, (i) => i.visibility.hiddenOperations);
const hiddenShapeIdsArrayAtom = selectAtom(setupAtom, (i) => i.visibility.hiddenShapeIds);
const hiddenSketchPortionsArrayAtom = selectAtom(setupAtom, (i) => i.visibility.hiddenSketchPortions);

// 모델별 숨김 바디 인덱스 Set
export const setupHiddenBodiesAtom = atom(
  (get): HiddenBodiesMap => recordToMap(get(hiddenBodiesRecordAtom)),
  (
    get,
    set,
    update: HiddenBodiesMap | ((prev: HiddenBodiesMap) => HiddenBodiesMap),
  ) => {
    const prev = recordToMap(get(hiddenBodiesRecordAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, hiddenBodies: mapToRecord(next) },
    }));
  },
);

// 모델별 삭제된 바디 인덱스 Set — SpecTree 에서 삭제 시 반영
export const setupDeletedBodiesAtom = atom(
  (get): HiddenBodiesMap => recordToMap(get(deletedBodiesRecordAtom)),
  (
    get,
    set,
    update: HiddenBodiesMap | ((prev: HiddenBodiesMap) => HiddenBodiesMap),
  ) => {
    const prev = recordToMap(get(deletedBodiesRecordAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, deletedBodies: mapToRecord(next) },
    }));
  },
);

// 숨김 모델 ID Set
export const setupHiddenModelsAtom = atom(
  (get): Set<string> => new Set(get(hiddenModelsArrayAtom)),
  (
    get,
    set,
    update: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(get(hiddenModelsArrayAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, hiddenModels: Array.from(next) },
    }));
  },
);

// 숨김 sketch planeKey Set (SpecTree 의 sketch entry visibility)
export const setupHiddenSketchesAtom = atom(
  (get): Set<string> => new Set(get(hiddenSketchesArrayAtom)),
  (
    get,
    set,
    update: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(get(hiddenSketchesArrayAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, hiddenSketches: Array.from(next) },
    }));
  },
);


// 숨김 definition / 일반 shape id Set (Shape entry + Definition entry 일괄 관리).
export const setupHiddenShapeIdsAtom = atom(
  (get): Set<string> => new Set(get(hiddenShapeIdsArrayAtom)),
  (
    get,
    set,
    update: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(get(hiddenShapeIdsArrayAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, hiddenShapeIds: Array.from(next) },
    }));
  },
);

// "Sketch" sub-entry (role-less primitive/shape) 를 숨긴 sketch planeKey Set.
export const setupHiddenSketchPortionsAtom = atom(
  (get): Set<string> => new Set(get(hiddenSketchPortionsArrayAtom)),
  (
    get,
    set,
    update: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(get(hiddenSketchPortionsArrayAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, hiddenSketchPortions: Array.from(next) },
    }));
  },
);

// 숨김 solid operation (Pad/Pocket/Revolve) ID Set
export const setupHiddenOperationsAtom = atom(
  (get): Set<string> => new Set(get(hiddenOperationsArrayAtom)),
  (
    get,
    set,
    update: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(get(hiddenOperationsArrayAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({
      ...p,
      visibility: { ...p.visibility, hiddenOperations: Array.from(next) },
    }));
  },
);

// --- 3D viewport / SpecTree 공용 hover & selection (session-transient, file 전환 시 reset) ---

/**
 * 3D viewport hover/select 상태 식별자 — Setup.type.ts 에 정의 (cycle 회피).
 * 자세한 설명은 Setup.type.ts 의 ViewportHoverItem JSDoc. top-level import 에서 노출.
 */
export type { ViewportHoverItem };

// 3D viewport hover (single) / selection (multi) — **standalone atom**.
// helper derived (setupDefinitionShapeHovered/SelectedId) 는 이 SSOT 에 kind 분기 derived 로
// 자동 연동됨.
export const setup3DHoverAtom = atom<ViewportHoverItem | null>(
  null as ViewportHoverItem | null,
);
export const setup3DSelectionAtom = atom<ViewportHoverItem[]>([]);

// SpecTree 에 표시할 스케치 목록
export const setupSketchEntriesAtom = atom<SketchTreeEntry[]>([]);

// 현재 활성 그리기 도구 — standalone (mode 무관, 임시 UI 상태).
export const setupDrawToolAtom = atom<SketchDrawToolType>("select");

// 글로벌 히스토리 undo/redo 상태 — _transient dispatch.
export const setupGlobalCanUndoAtom = atom(
  (get) => get(setupAtom).globalCanUndo,
  (get, set, value: boolean) =>
    set(setupAtom, (p) => ({ ...p, globalCanUndo: value })),
);
export const setupGlobalCanRedoAtom = atom(
  (get) => get(setupAtom).globalCanRedo,
  (get, set, value: boolean) =>
    set(setupAtom, (p) => ({ ...p, globalCanRedo: value })),
);


// Pad/Pocket 작업 목록 (globalData.input.operations 의 derived atom)
export const setupOperationsAtom = atom(
  (get) => get(setupAtom).operations,
  (
    get,
    set,
    update:
      | OperationTreeEntry[]
      | ((prev: OperationTreeEntry[]) => OperationTreeEntry[]),
  ) => {
    const prev = get(setupAtom).operations;
    const operations = typeof update === "function" ? update(prev) : update;
    set(setupAtom, (p) => ({ ...p, operations }));
  },
);

// TODO: 6개 mode atom 을 하나의 discriminated union 으로 통합 검토
// (padPocket, dimension, fillet, chamfer, offset, sketchPending)
// **standalone** — 편집 중 모드 상태 (임시).
export const setupPadPocketModeAtom = atom<PadPocketModeState>(
  null as PadPocketModeState,
);

// Assembly 구속 목록
export const setupConstraintsAtom = atom<ConstraintTreeEntry[]>([]);

export const setupSelectedFacesAtom = atom<SelectedSketchFace[]>([]);

/**
 * undo / redo manager — setup storage 의 `globalHistory` derived (read-only).
 * 파일별 스코프 (setupAtom 이 file-scoped) — 파일 이동 시 파일별 undo stack 유지. caller 는
 * 이 instance 의 `.executeCommand` / `.clearSubSystems` 등 method 직접 호출.
 */
export const setupGlobalHistoryAtom = atom((get) => get(setupAtom).globalHistory);

// GeometryStoreBundle type 은 Setup.type.ts.
export function createGeometryStoreBundle(): GeometryStoreBundle {
  const store = new SketchGeometryStore();
  const constraintStore = new SketchConstraintStore();
  const solver = new SketchConstraintSolver();
  store.constraintStore = constraintStore;
  store.solver = solver;
  // constraint mutation 시 solver cache 무효화 (cache key 는 id+type 뿐 — value 변경 자동감지 X)
  constraintStore.addMutationListener(() => solver.invalidateCache());
  return { store, constraintStore, solver };
}

export const setupGeometryStoreBundleAtom = atom<GeometryStoreBundle>(
  createGeometryStoreBundle(),
);

/**
 * **Phase 7 이동**: `resultEngineAtom` / `resultGeometryStoreBundleAtom` 을
 * `src/features/result/Result.store.ts` 로 이동. result page 는 거기서 import.
 * Setup / Result 스코프 흐름은 그대로 (별도 instance + simulate/optimize handler 로
 * setup → result deep clone).
 */

/**
 * Baked sketches single source — planeKey → SerializedSketch.
 * BakedSketchManager 의 mutation 을 이 atom 으로 sync. 컴포넌트 lifecycle 과 독립적이고
 * 페이지 / 파일 이동 후 SetupScene 리마운트 시 이 atom 값으로 시각화 재구성.
 *
 * Map 대신 plain object 사용 — atom set 마다 새 객체 reference 만들기 위해 (immutable update).
 */
export const setupBakedSketchesAtom = atom<Record<string, SerializedSketch>>(
  {},
);



// 구속 솔버 상태 (Phase 2) — _transient dispatch.
export const setupConstraintSolveStatusAtom = atom(
  (get): SolveStatus => get(setupAtom).constraintSolveStatus,
  (get, set, value: SolveStatus) =>
    set(setupAtom, (p) => ({ ...p, constraintSolveStatus: value })),
);

// 자유도 (under-constrained 시 남은 DOF) — CATIA "N degrees of freedom" 표시용. _transient dispatch.
export const setupSketchDofAtom = atom(
  (get) => get(setupAtom).sketchDof,
  (get, set, value: number) =>
    set(setupAtom, (p) => ({ ...p, sketchDof: value })),
);

// 구속 적용 가능 여부 (현재 선택 기준)
// TODO: derive from selection + geometry state
// **standalone** — selection 기반 파생, mode 스코프 불필요 + drag 흐름 보호.
export const setupConstraintApplicabilityAtom = atom<ConstraintApplicability>(
  EMPTY_CONSTRAINT_APPLICABILITY,
);

// 현재 selection 에 이미 적용된 constraint 타입 Set — Toolbar toggle 활성 표시용. **standalone**.
export const setupAppliedConstraintTypesAtom = atom<Set<string>>(new Set<string>());

// Constraint Definition Dialog open 상태 — Dimension 등 버튼 대응
export const setupConstraintDialogOpenAtom = setupGroupFieldAtom("panelOpen", "constraintDialog");

// Baked sketch role-shape (BakedShapeRenderer) 의 hover/select.
// **Helper derived atom** — SSOT 는 setup3DHover/Selection. kind: "definitionShape" 항목.
export const setupDefinitionShapeHoveredIdAtom = atom(
  (get) => {
    const h = get(setup3DHoverAtom);
    return h?.kind === "definitionShape" ? h.id : null;
  },
  (get, set, value: string | null) => {
    const prev = get(setup3DHoverAtom);
    // same-value skip + cross-kind 보호 — applyHighlight 의 cross-source clear 가 매 mouseMove
    // frame 마다 호출되는데, prev hover 가 다른 kind (originPlane 등) 면 mutate 안 함.
    // 매 frame atom 변경 cycle 방지.
    if (value === null) {
      if (prev === null || prev.kind !== "definitionShape") return;
    } else {
      if (prev?.kind === "definitionShape" && prev.id === value) return;
    }
    set(setup3DHoverAtom, value === null ? null : { kind: "definitionShape", id: value });
  },
);
export const setupDefinitionShapeSelectedIdAtom = atom(
  (get) => {
    const found = get(setup3DSelectionAtom).find((s) => s.kind === "definitionShape");
    return found?.kind === "definitionShape" ? found.id : null;
  },
  (get, set, value: string | null) => {
    const sel = get(setup3DSelectionAtom);
    const found = sel.find((s) => s.kind === "definitionShape");
    const prevId = found?.kind === "definitionShape" ? found.id : null;
    // same-value skip.
    if (value === prevId) return;
    set(setup3DSelectionAtom, () => {
      const filtered = sel.filter((s) => s.kind !== "definitionShape");
      return value === null ? filtered : [...filtered, { kind: "definitionShape", id: value }];
    });
  },
);


// 치수 모드 (편집 중 모드 상태) — **standalone** (임시 UI, mode 스코프 불필요).
export const setupDimensionModeAtom = atom<DimensionModeState>(
  null as DimensionModeState,
);
export const setupFilletModeAtom = atom<FilletModeState>(
  null as FilletModeState,
);
export const setupChamferModeAtom = atom<ChamferModeState>(
  null as ChamferModeState,
);

// 기본 파라미터 수치 (user preference — 세션 유지) — **standalone**.
export const setupFilletRadiusAtom = atom<number>(5);
export const setupChamferDistanceAtom = atom<number>(5);
export const setupChamferDistance2Atom = atom<number>(5);

export const setupOffsetModeAtom = atom<OffsetModeState>(
  null as OffsetModeState,
);
export const setupOffsetDistanceAtom = atom<number>(5);

export const setupSnapDisplayAtom = atom<SnapDisplayInfo>(
  null as SnapDisplayInfo,
);

// 스케치 월드 좌표 (도구 활성 시 마우스 위치, 좌표 표시 등)
export const setupSketchWorldPosAtom = atom<{ x: number; y: number } | null>(
  null as { x: number; y: number } | null,
);

// 기하 구속 자동 생성 모드 (CATIA Sketch Tools)
export const setupAutoGeoConstraintAtom = atom(
  (get) => get(setupAtom).autoGeoConstraint,
  (get, set, value: boolean | ((prev: boolean) => boolean)) =>
    set(setupAtom, (p) => ({
      ...p,
      autoGeoConstraint: typeof value === "function" ? value(p.autoGeoConstraint) : value,
    })),
);

// 그리드 표시 모드 (스케치 모드)
export const setupGridVisibleAtom = atom(true);


// 그리드 간격 (mm)
export const setupGridSpacingAtom = atom(10);

// 그리드 세분화 분할 수
export const setupGridSubdivisionsAtom = atom(5);

// 스냅 활성화 모드 (비활성 시 그리드/기하 스냅 모두 해제)
export const setupSnapEnabledAtom = atom(true);

// 그리드 스냅 활성화 모드 (CATIA: Grid 의 하위인 Snap to Grid 버튼)
// false 여도 기하 스냅은 inputSnapEnabledAtom 으로 별도 제어
export const setupGridSnapEnabledAtom = atom(true);

// Construction 모드 토글 (활성 시 새 도형을 construction 으로 생성)
export const setupConstructionModeAtom = atom(
  (get) => get(setupAtom).constructionMode,
  (get, set, value: boolean | ((prev: boolean) => boolean)) =>
    set(setupAtom, (p) => ({
      ...p,
      constructionMode: typeof value === "function" ? value(p.constructionMode) : value,
    })),
);

// Dimensional Constraints 자동 생성 모드
export const setupAutoDimConstraintAtom = atom(
  (get) => get(setupAtom).autoDimConstraint,
  (get, set, value: boolean | ((prev: boolean) => boolean)) =>
    set(setupAtom, (p) => ({
      ...p,
      autoDimConstraint: typeof value === "function" ? value(p.autoDimConstraint) : value,
    })),
);

// 선택된 요소 속성 정보 (SnapInfoPanel 에서 상세 정보 표시) — **standalone atom** (drag 시
// 매 mouse move 마다 새 SelectionPropertyInfo object 생겨 dispatch 경유 시 globalData
// chain 비용 발생).
export const setupSelectionInfoAtom = atom<SelectionPropertyInfo | null>(
  null as SelectionPropertyInfo | null,
);

// 스케치 모드 SpecTree: 현재 활성 스케치 이름 — **standalone** (sketch 진입 시 set, 임시).
export const setupActiveSketchNameAtom = atom<string>("");

// 스케치 모드 SpecTree: 형상 목록
export const setupSketchGeometryListAtom = atom<SketchGeometryTreeItem[]>([]);

// 스케치 모드 SpecTree: Shape 목록
export const setupSketchShapeListAtom = atom<SketchShapeTreeItem[]>([]);

// 스케치 모드 SpecTree: 구속 목록
export const setupSketchConstraintListAtom = atom<SketchConstraintTreeItem[]>(
  [],
);

// Profile 도구 sub-mode (line / arc / spline 등) — **standalone** (도구 옵션).
export const setupProfileModeAtom = atom<ProfileMode>("line");

// Connect 도구 연속성 모드 (G0 / G1 / G2) — CATIA V5 Connect 옵션 — **standalone** (user pref).
export const setupConnectContinuityAtom = atom<ConnectContinuity>("G1");

/**
 * CATIA PreSelection Navigator UI 상태. **standalone** — hover 기반 임시 상태, mode 스코프 무의미.
 * type PreSelectionCandidate / PreSelectionNavState 는 Setup.type.ts.
 */
export const setupPickCandidatesNavAtom = atom<PreSelectionNavState>(
  null as PreSelectionNavState,
);

// 구속 심볼 표시 모드 (false 면 ConstraintRenderer 에서 스킵). visibility group persistent.
export const setupConstraintVisibleAtom = setupGroupFieldAtom("visibility", "constraintVisible");

// 구속 타입별 표시 필터 (master toggle 과 AND). visibility group persistent.
// geometric: H/V/parallel/perpendicular/coincident/tangent 등 기하 구속 심볼
// dimensional: distance/radius/angle 등 치수 구속 값
export const setupConstraintVisibilityFilterAtom = setupGroupFieldAtom("visibility", "constraintVisibilityFilter");

// Undo/Redo 피드백: 되돌린 요소 ID + 플래시 타이머. **standalone** — flash UI, 잠시 표시 후 사라짐.
export const setupUndoFlashIdsAtom = atom<string[]>([]);

// 스케치 커맨드 콜백 (ref 기반 prop drilling 을 대체하는 Jotai atom)
// SetupCanvas 내부의 useSketchRefCallbacks 에서 주입, index.tsx 등 상위 컴포넌트에서 사용
const defaultSketchCommands: SketchCommands = {
  applyConstraint: null,
  autoConstraint: null,
  dimensionConfirm: null,
  filletConfirm: null,
  chamferConfirm: null,
  filletPreview: null,
  chamferPreview: null,
  offsetConfirm: null,
  offsetPreview: null,
  projectEdges: null,
  projectSilhouette: null,
  intersect3D: null,
  sketchToolsClick: null,
  sketchToolsApply: null,
  getDrawTool: null,
  selectGeometry: null,
  selectConstraint: null,
  deleteGeometry: null,
  toggleConstruction: null,
  deleteConstraint: null,
  doubleClickConstraint: null,
  constraintValueChange: null,
  renameRigidGroup: null,
  dissolveRigidGroup: null,
  getAnalysisData: null,
};

export const sketchCommandsAtom = atom<SketchCommands>(defaultSketchCommands);

/** 파일 로드 시 복원 대기 스케치 데이터 (scene 준비 후 InputCanvas 에서 소비). SetupData 기반 (cameraState 포함). */
export const setupPendingRestoreAtom = atom<SetupData | null>(
  null as SetupData | null,
);

/** 현재 로컬 input 상태를 globalData.input 에 flush 하는 콜백 (Input 컴포넌트에서 등록) */
const _inputFlushSyncBaseAtom = atom<{ fn: (() => void) | null }>({ fn: null });
export const setupFlushSyncAtom = atom(
  (get) => get(_inputFlushSyncBaseAtom).fn,
  (_get, set, fn: (() => void) | null) => {
    set(_inputFlushSyncBaseAtom, { fn });
  },
);

// UI atom 일괄 리셋 (파일 전환 시)

type JotaiStore = ReturnType<typeof createStore>;

/**
 * 파일 전환 시 단순 기본값으로 복원해야 하는 UI 로컬 atom 리셋 목록.
 * 새 UI atom 추가 시 **여기에 반드시 등록** — 안 그러면 이전 파일 상태가 다음 파일로 누수.
 * (globalData derived atom 은 자동 전환되므로 제외 — inputModels, inputOperations 등)
 */
// UI_ATOM_RESETS — file 전환 시 reset 하는 목록 (standalone atom 등)
//
// **분류 원칙:**
// - **dispatch atom (= SetupTransientState 의 field, setupAtom dispatch)** — fileId 에
//   자동 스코프. 여기서 reset 하면 자동 스코프 효과를 무효화 — 파일 전환 시 default 로 강제 reset.
//   **여기 등록 X**. 이 목록에 넣지 말 것 — 자동 스코프에 맡김.
// - **standalone module-level atom** — fileId 스코프 X. 파일 load effect 에서 다시 set
//   안 하면 이전 파일 상태 잔류 회귀 — 여기서 reset 필요. **여기 등록**.
//
// 임시 UI / dialog / 편집 중 모드 등 — dispatch atom 이면 reset 안 해도 되지만
// 명시하면 더 안전 — 잦으면 atom 자체를 standalone 으로 이동 검토 (성능 고려).
const UI_ATOM_RESETS: ReadonlyArray<(s: JotaiStore) => void> = [
  // STEP model runtime form — file load effect 에서 다시 set.
  (s) => s.set(setupModelsRuntimeAtom, []),
  // Sketch entries / faces / constraints / profiles cache — sketch 진입 시 rebuild.
  (s) => s.set(setupSketchEntriesAtom, []),
  (s) => s.set(setupSelectedFacesAtom, []),
  (s) => s.set(setupConstraintsAtom, []),
  (s) => s.set(setupProfilesAtom, []),
  // SpecTree list cache — geometryStore listener 로 rebuild.
  (s) => s.set(setupSketchGeometryListAtom, []),
  (s) => s.set(setupSketchConstraintListAtom, []),
  (s) => s.set(setupSketchShapeListAtom, []),
  // 9 standalone atom (B 분류) — 파일 전환 시 이전 값 잔류 방지.
  (s) => s.set(setupConstraintApplicabilityAtom, EMPTY_CONSTRAINT_APPLICABILITY),
  (s) => s.set(setupAppliedConstraintTypesAtom, new Set<string>()),
  (s) => s.set(setupPickCandidatesNavAtom, null),
  (s) => s.set(setupUndoFlashIdsAtom, []),
  // Baked sketches (singleton) — file/mode 스코프. mount 시 sketches 로 atom hydrate.
  (s) => s.set(setupBakedSketchesAtom, {}),
  // Sketch / Ref plane / 3D viewport / Tool 관련 모든 standalone atom — file/mode
  // 변경 시 남아있는 편집 모드 / 선택 / hover 상태 정리.
  (s) => s.set(setupRefPlaneModeAtom, null),
  (s) => s.set(setupRefPlanePreviewAtom, null),
  (s) => s.set(setupSketchPlaneAtom, null),
  (s) => s.set(setupSketchPlaneSelectionPendingAtom, false),
  (s) => s.set(setupSketchSelectedIdsAtom, []),
  (s) => s.set(setupSketchHoveredItemAtom, null),
  (s) => s.set(setupSketchSelectedConstraintIdAtom, null),
  (s) => s.set(setup3DHoverAtom, null),
  (s) => s.set(setup3DSelectionAtom, []),
  (s) => s.set(setupPadPocketModeAtom, null),
  (s) => s.set(setupDimensionModeAtom, null),
  (s) => s.set(setupFilletModeAtom, null),
  (s) => s.set(setupChamferModeAtom, null),
  (s) => s.set(setupOffsetModeAtom, null),
  (s) => s.set(setupActiveSketchNameAtom, ""),
  (s) => s.set(setupSnapDisplayAtom, null),
  (s) => s.set(setupSketchWorldPosAtom, null),
];

/**
 * 파일 전환 시 input feature 의 UI atom 을 일괄 초기화.
 * - 단순 기본값 atom: UI_ATOM_RESETS 리스트로 일괄 리셋
 * - persistent 파생 계산값: viewMode / currentScene / timelineSelected
 */
export function resetInputUIAtoms(
  store: JotaiStore,
  _setupData: SetupData,
): void {
  for (const reset of UI_ATOM_RESETS) reset(store);

  // globalHistory 는 file 별 스코프 (setupAtom storage scoped + atomFamily 로 fresh instance).
  // 파일 이동 시 파일별 undo stack 유지하려 여기서 clear 안 함 — 새 파일이면 atomFamily
  // factory 가 이미 새 manager 를 생성했고, 기존 파일이면 이전 stack 그대로 활성화.

  // viewMode / currentScene 은 globalData.input.viewState 의 derived atom — 직접 set 호출
  // 안 함. globalData 가 file data 로 set 되면 derive 로 자동 반영. set 호출 시 setupAtom
  // setter 가 globalData 를 mutation 해 originData 와 mismatch ('* dirty 표시') 유발함.
}
