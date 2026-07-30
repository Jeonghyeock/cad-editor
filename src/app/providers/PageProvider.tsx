// PageProvider — 각 페이지 (input / explore / result) 의 atom 을 격리된 Jotai store 로 감쌈.
//
// 사용:
//   <PageProvider pageId="setup"><Setup /></PageProvider>
//
// version key — `resetPageStore(pageId)` 호출 시 version bump → React 가 key 변화로
// 인식해 PageProvider 자식 subtree 통째 재mount → 페이지 컴포넌트가 새 store 로
// 시작하면서 모든 atom default 값으로 초기화 (= 페이지 reset).

import { Provider } from "jotai";
import React, { useSyncExternalStore } from "react";

import {
  getPageStore,
  getPageStoreVersion,
  type PageId,
  subscribePageVersion,
} from "./pageStores";

type Props = {
  pageId: PageId;
  children: React.ReactNode;
};

const PageProvider = ({ pageId, children }: Props) => {
  const version = useSyncExternalStore(
    subscribePageVersion,
    () => getPageStoreVersion(pageId),
    () => getPageStoreVersion(pageId),
  );
  const store = getPageStore(pageId);
  // key={version} — version bump 시 subtree 재mount → 페이지 컴포넌트 fresh.
  return (
    <Provider key={version} store={store}>
      {children}
    </Provider>
  );
};

export default PageProvider;
