import "./helpers/assetStub";

import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  setupGlobalHistoryAtom,
  setupReferencePlanesAtom,
  setupRefPlaneModeAtom,
} from "src/features/setup/Setup.store";

import { fileIdAtom } from "src/shared/stores/File.store";

// 2026-10-28 코드리뷰 cad-editor#42 — 참조 평면 생성·삭제가 통합 history 를 거치지 않아, 평면을 만들거나 지운 뒤
// Ctrl+Z 하면 평면이 아니라 그 전 작업(예: Pad)이 취소됐다.

// PlaneDefinitionPanel 을 렌더하지 않고 함수로 불러, 돌려준 요소 트리에서 OK 버튼의 onClick 을 누른다.
// 훅은 jotai store 를 직접 읽고 쓰게 대신하고, useState/useEffect/useCallback 은 첫 렌더의 값만 준다.
const store = jotai.createStore();
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};
type AnyAtom = Parameters<typeof store.get>[0];
type WritableAnyAtom = Parameters<typeof store.set>[0];
stub("react", {
  ...React,
  memo: (component: unknown) => component,
  useState: (init: unknown) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
});
stub("jotai", {
  ...jotai,
  useStore: () => store,
  useAtomValue: (atom: AnyAtom) => store.get(atom),
  useSetAtom: (atom: WritableAnyAtom) => (value: unknown) => store.set(atom, value),
  useAtom: (atom: WritableAnyAtom) => [store.get(atom), (value: unknown) => store.set(atom, value)],
});
// 패널 틀(드래그 훅)은 이 테스트와 관계없다
stub("src/features/setup/components/FloatingPanel", { __esModule: true, default: () => null });

type Element = React.ReactElement<{ children?: React.ReactNode; footer?: React.ReactNode; onClick?: () => void }>;
function findButton(node: React.ReactNode, label: string): Element | null {
  if (!React.isValidElement(node)) return null;
  const el = node as Element;
  if (el.type === "button" && React.Children.toArray(el.props.children).includes(label)) return el;
  for (const child of React.Children.toArray(el.props.children)) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return el.props.footer ? findButton(el.props.footer, label) : null;
}

test("참조 평면을 만든 뒤 Ctrl+Z 하면 그 평면이 빠지고, 그 전 작업은 그대로다", async () => {
  store.set(fileIdAtom, "a");
  const history = store.get(setupGlobalHistoryAtom);
  // 앞서 한 작업(Pad 생성 등)
  let padExists = false;
  history.executeCommand({ label: "Create Pad", execute: () => (padExists = true), undo: () => (padExists = false) });

  // 평면 선택까지 끝낸 Plane Definition 패널에서 OK
  store.set(setupRefPlaneModeAtom, {
    step: "select-plane",
    selectionMode: "face",
    basePlane: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    basePlaneName: "XY Plane",
  });
  const { default: PlaneDefinitionPanel } = await import("src/features/setup/components/PlaneDefinitionPanel");
  const panel = (PlaneDefinitionPanel as unknown as () => React.ReactNode)();
  findButton(panel, "OK")?.props.onClick?.();
  assert.equal(store.get(setupReferencePlanesAtom).length, 1);
  assert.equal(store.get(setupReferencePlanesAtom)[0].plane.origin.z, 10);

  // 고치기 전에는 평면은 남고 Pad 가 취소됐다
  history.undo();
  assert.equal(store.get(setupReferencePlanesAtom).length, 0);
  assert.equal(padExists, true);

  history.redo();
  assert.equal(store.get(setupReferencePlanesAtom).length, 1);
});
