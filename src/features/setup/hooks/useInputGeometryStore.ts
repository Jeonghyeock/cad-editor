// SketchGeometryStore 등 인스턴스 묶음 — problem-definition 의 sketcherAtom 패턴.
// 인스턴스는 모듈 atom (setupGeometryStoreBundleAtom) 에 영속, hook 은 단순 반환 +
// 컴포넌트 mount 시 listener 등록. 컴포넌트 lifecycle 와 무관하게 데이터 보존.
//
// **bundleAtom 인자 패턴** — default `setupGeometryStoreBundleAtom` (Setup bundle). Result
// 페이지가 `resultGeometryStoreBundleAtom` 전달 가능 — explore mechanism 의 sketch primitive
// 가 setup bundle 을 오염시키지 않도록.

import { type Atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import {
  type GeometryStoreBundle,
  setupConstraintSolveStatusAtom,
  setupGeometryStoreBundleAtom,
  setupSketchDofAtom,
} from "../Setup.store";
import type { SketchConstraintStore } from "../sketch/constraints/SketchConstraintStore";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";

type UseInputGeometryStoreReturn = {
  store: SketchGeometryStore;
  constraintStore: SketchConstraintStore;
};

export const useInputGeometryStore = (
  bundleAtom: Atom<GeometryStoreBundle> = setupGeometryStoreBundleAtom,
): UseInputGeometryStoreReturn => {
  const bundle = useAtomValue(bundleAtom);
  const { store, constraintStore, solver } = bundle;

  const setSolveStatus = useSetAtom(setupConstraintSolveStatusAtom);
  const setDof = useSetAtom(setupSketchDofAtom);

  // planegcs WASM solver 초기화 — idempotent.
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    solver.init().catch((err) => {
      console.error("[useInputGeometryStore] planegcs Wasm init failed:", err);
    });
  }, [solver]);

  // 스토어 상태 변경 시 atoms 동기화 (mount 시 listener 등록, unmount 시 해제. 인스턴스 보존)
  useEffect(() => {
    const unsubscribe = store.addRenderListener(() => {
      setSolveStatus(store.solveStatus);
      setDof(store.dof);
    });
    return unsubscribe;
  }, [store, setSolveStatus, setDof]);

  return { store, constraintStore };
};
