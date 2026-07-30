import { GlobalHistoryManager } from "./core/GlobalHistoryManager";
import type { SetupData } from "./Setup.type";

/**
 * `SetupData` deep clone — `structuredClone` 이 다루지 못하는 class instance (특히
 * `GlobalHistoryManager` 의 `_renderListeners: Set<Function>` 와 `_engine` / `_geometryStore`
 * reference) 를 fresh 로 교체한 뒤 나머지는 structuredClone.
 *
 * 호출 시점: `setup` 의 deep snapshot 이 필요한 곳. `structuredClone(setupData)` 가 Function
 * 만나면 DataCloneError throw — 그 cycle 차단.
 */
export function cloneSetupData(src: SetupData): SetupData {
  // globalHistory 는 따로 떼고 나머지만 structuredClone — class instance / function 회피.
  const { globalHistory: _gh, ...rest } = src;
  const cloned = structuredClone(rest);
  return { ...cloned, globalHistory: new GlobalHistoryManager() } as SetupData;
}

// Input 메모리 데이터 초기값 — SetupData (= persistent + 메모리 전용 필드).
// .cad 디스크 저장은 extractSetupPersistentData 로 persistent 만 추출.
//
// **주의**: 여기의 mutable field (Map / Set / GlobalHistoryManager / array) 는 module-level
// 단일 instance 라 file 별 격리가 보장 안 됨. `fileDataAtomFamily` factory 에서는 아래
// `makeInitialSetupData()` 로 fresh instance 생성. 이 constant 자체는 정적 비교 / reset 기준
// reference 로만 사용.
export const INITIAL_SETUP_DATA: SetupData = {
  models: [],
  sketches: [],
  operations: [],
  referencePlanes: [],
  viewState: { mode: "3d", currentScene: 0 },
  visibility: {
    hiddenModels: [],
    hiddenBodies: {},
    deletedBodies: {},
    hiddenSketches: [],
    hiddenOperations: [],
    hiddenShapeIds: [],
    hiddenSketchPortions: [],
    constraintVisible: true,
    constraintVisibilityFilter: { geometric: true, dimensional: true },
  },
  // ── SetupTransientState (file 저장 X — extractSetupPersistentData 가 자동 omit) ──
  // 메모리 전용 — 디스크 저장 안 됨, 앱 재시작 시 default 로 reset.
  cameraState: null,
  // history 는 INITIAL constant 의 default instance (atomFamily factory 에서 file 별 fresh
  // instance 로 덮어씌움 — File.store.ts 참조).
  globalHistory: new GlobalHistoryManager(),
  globalCanUndo: false,
  globalCanRedo: false,
  constraintSolveStatus: "ok",
  sketchDof: -1,
  panelOpen: {
    constraintDialog: false,
  },
  constructionMode: false,
  autoDimConstraint: false,
  autoGeoConstraint: true,
  selectionFilter: "all",
};

/**
 * fresh `SetupData` 인스턴스 생성 — `INITIAL_SETUP_DATA` 의 module-level 단일 reference 가
 * 여러 file 에 공유되는 위험 (mutable Map / Set / GlobalHistoryManager 가 cross-file mutation
 * 으로 새 나갈 위험) 을 차단하기 위한 factory.
 *
 * 호출 시점:
 *  - `fileDataAtomFamily(fileId)` factory — 새 fileId 첫 access 시 setup storage 에 별개 instance 주입
 *  - 그 외 코드는 `INITIAL_SETUP_DATA` 의 static reference 를 reset / compare 용으로 그대로 사용
 *
 * 새 mutable field 추가 시 여기에도 fresh instance 를 만들어 넣을 것.
 */
export function makeInitialSetupData(): SetupData {
  return {
    ...INITIAL_SETUP_DATA,
    globalHistory: new GlobalHistoryManager(),
  };
}
