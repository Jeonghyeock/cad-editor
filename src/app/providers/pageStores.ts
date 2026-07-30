// Page-scoped Jotai store cache.
//
// 각 페이지 (setup / explore / result) 는 자기 store 인스턴스를 가질 수 있도록 설계.
// 상단 페이지 탭 이동은 store 보존 (cache hit), sidebar 의 simulate/optimize/generate
// 버튼은 destination store reset (version bump) 으로 페이지 컴포넌트 재mount.
//
// **현재 단계**: 모든 page store 가 outer store 와 동일 instance 를 반환 — atom 정의
// 자체에서 globalData.setup / globalData.result 같은 storage 분리로 격리 (Phase 1-7).
// Phase 8 (createStore activate + bidirectional mirror) 은 atom set cascade + sync 의
// re-render 폭증 회귀 (build 3D mechanism 시 렉 발생) 로 revert. 사용자 mental model 의
// 격리는 Phase 7 의 simulate/optimize/generate handler 의 setup → result deep clone +
// Result.store 의 resultEngineAtom / resultGeometryStoreBundleAtom 분리로 달성됨.

import type { createStore } from "jotai";

import { outerStore } from "./StoreProvider";

export type PageId = "setup" | "explore" | "result";

/** page store 인스턴스 캐시 — id 당 하나. reset 시 새 인스턴스로 교체. */
const pageStores = new Map<PageId, ReturnType<typeof createStore>>();
/**
 * page store version — `<PageProvider key={version}>` 으로 React subtree 강제 remount
 * 트리거. reset 시 increment.
 */
const pageVersions = new Map<PageId, number>();

/** version 변화 subscribers — PageProvider 가 useSyncExternalStore 로 watch. */
const versionSubscribers = new Set<() => void>();

/**
 * 캐시된 page store 반환. 첫 호출 시 lazy 생성.
 *
 * **현재 단계**: outer store 인스턴스를 그대로 반환. 격리는 atom 정의 (globalData.setup
 * vs globalData.result) 와 simulate/optimize handler 의 deep clone 으로 처리.
 */
export function getPageStore(id: PageId): ReturnType<typeof createStore> {
  let store = pageStores.get(id);
  if (!store) {
    store = outerStore;
    pageStores.set(id, store);
    pageVersions.set(id, 0);
  }
  return store;
}

/** page store version — `<PageProvider key>` 에 사용. version 변경 시 React subtree 재mount. */
export function getPageStoreVersion(id: PageId): number {
  if (!pageVersions.has(id)) pageVersions.set(id, 0);
  return pageVersions.get(id) ?? 0;
}

/** PageProvider 가 version 변화 구독 — useSyncExternalStore subscribe 함수. */
export function subscribePageVersion(cb: () => void): () => void {
  versionSubscribers.add(cb);
  return () => {
    versionSubscribers.delete(cb);
  };
}

/**
 * page store reset — version bump + subscribers 알림. 현재는 outer store 와 같은 instance
 * 라 atom 값 reset 효과 X. 격리는 simulate/optimize handler 의 setup → result deep clone
 * 으로 처리됨 (Phase 5/6/7).
 */
export function resetPageStore(id: PageId): ReturnType<typeof createStore> {
  const store = outerStore;
  pageStores.set(id, store);
  pageVersions.set(id, (pageVersions.get(id) ?? 0) + 1);
  versionSubscribers.forEach((cb) => cb());
  return store;
}
