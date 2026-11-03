import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PadPocketModeState } from "src/features/setup/Setup.type";

// PadPocketPanel 을 React 없이 부른다. useState 는 칸을 기억하고, effect 는 한 번 돌린 뒤 다시 그린다
// (React 의 첫 렌더 → effect → 재렌더 순서). 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 대신할
// 모듈을 넣어 둔다.
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};

let slots: unknown[] = [];
let cursor = 0;
let effects: (() => unknown)[] = [];
stub("react", {
  ...React,
  memo: <T,>(component: T) => component,
  useState: (init: unknown) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (next: unknown) => {
      slots[i] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[i]) : next;
    };
    return [slots[i], set];
  },
  useEffect: (fn: () => unknown) => { effects.push(fn); },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
});
let mode: PadPocketModeState = null;
stub("jotai", { ...jotai, useAtom: () => [mode, () => {}] });
// Setup.store 는 아이콘(svg) 까지 불러와 node 에서 읽을 수 없다. 패널은 mode atom 만 쓴다.
stub("src/features/setup/Setup.store", { setupPadPocketModeAtom: jotai.atom(null) });
stub("src/features/setup/components/FloatingPanel", { default: () => null });

type Element = { type: unknown; props: { className?: string; value?: unknown; children?: unknown } };
const childrenOf = (el: Element): Element[] =>
  ([] as unknown[]).concat(el.props.children ?? []).filter((c): c is Element => !!c && typeof c === "object");

/** 패널을 그리고, 입력란 라벨 → 표시 값 */
async function renderPanel(m: PadPocketModeState): Promise<Record<string, unknown>> {
  const { default: PadPocketPanel } = await import("src/features/setup/components/PadPocketPanel");
  const Panel = PadPocketPanel as unknown as (props: object) => Element;
  const props = { getScene: () => null, getGeometries: () => new Map(), onConfirm: () => {}, onCancel: () => {} };
  mode = m;
  slots = [];
  cursor = 0;
  effects = [];
  Panel(props);
  for (const effect of effects) effect();
  cursor = 0;
  effects = [];
  const root = Panel(props);

  const fields: Record<string, unknown> = {};
  const visit = (el: Element) => {
    if (el.props.className === "input__pad-pocket-panel__field") {
      const [label, input] = childrenOf(el);
      if (input?.type === "input") fields[String(label.props.children)] = input.props.value;
    }
    childrenOf(el).forEach(visit);
  };
  visit(root);
  return fields;
}

test("Draft·2-Dim Pad 를 편집하면 패널이 기존 Draft Angle·Depth 2 를 보여 준다", async () => {
  // 고치기 전에는 편집 모드에 depth2·draftAngle 이 없고 패널이 Draft 0, Depth 2 = Depth 1 로 초기화해,
  // Depth 만 바꿔 OK 해도 테이퍼와 반대 방향 깊이가 사라졌다
  const fields = await renderPanel({
    type: "pad",
    sketchPlaneKey: "k",
    profileIds: [],
    depth: 20,
    depth2: 8,
    direction: "two-dimensions",
    draftAngle: 5,
    editingOperationId: "op1",
  });
  assert.deepEqual(fields, { "Depth 1 (mm)": 20, "Depth 2 (mm)": 8, "Draft Angle (°)": 5 });
});

test("새 Pad 는 전처럼 Depth 2 = Depth, Draft 0 으로 시작한다", async () => {
  const fields = await renderPanel({
    type: "pad",
    sketchPlaneKey: "k",
    profileIds: [],
    depth: 20,
    direction: "normal",
  });
  assert.deepEqual(fields, { "Depth (mm)": 20, "Draft Angle (°)": 0 });
});
