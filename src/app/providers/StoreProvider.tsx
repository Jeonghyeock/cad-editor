import { createStore, Provider } from "jotai";
import React from "react";

/**
 * Outer (app-wide) Jotai store — cross-page 공유 atom (fileData, config, toast, contextMenu,
 * optimize jobs 등) 전용. page-scoped atom (input/explore/result 의 transient UI state)
 * 은 PageProvider 안의 별도 store 에 격리. {@link getOuterStore} 로 외부에서 접근 가능.
 */
export const outerStore = createStore();

/** non-React 코드 (페이지 hand-off, file save-on-leave 등) 에서 outer store 직접 접근. */
export const getOuterStore = () => outerStore;

const StoreProvider = ({
  children,
}: Readonly<{ children: React.ReactNode }>) => {
  return <Provider store={outerStore}>{children}</Provider>;
};

export default StoreProvider;
