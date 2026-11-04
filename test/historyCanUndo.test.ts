import "./support/browserStubs";

import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HistoryEvent } from "src/features/setup/core/GlobalHistoryManager";
import { setupGlobalCanRedoAtom, setupGlobalCanUndoAtom } from "src/features/setup/Setup.store";
import { AddGeometryCommand } from "src/features/setup/sketch/commands/AddGeometryCommand";

import { createSketch, line } from "./helpers/sketch";

// 2026-10-28 코드리뷰 cad-editor#18·#23 리뷰 반영 — 다른 스케치 엔트리에서 undo/redo 가 막힌 동안에도 canUndo/canRedo 가
// 스택 위치만 봐 툴바 버튼이 켜진 채 눌러도 아무 일이 없었다.

test("맨 위 엔트리가 다른 스케치의 것이면 canUndo/canRedo 가 false 다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));
  store.execute(new AddGeometryCommand(line("M", 0, 0, 5, 10)));
  history.undo();
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, true);

  history.setActiveSketch(null);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);

  history.setActiveSketch("YZ");
  assert.equal(history.canUndo, false);

  history.setActiveSketch("XY");
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, true);
});

test("스케치를 열고 닫으면 툴바의 undo/redo 상태를 다시 맞추되, 저장 동기화(flush)는 부르지 않는다", async () => {
  const { store, history } = await createSketch();
  store.execute(new AddGeometryCommand(line("L", 0, 0, 10, 5)));

  // useGlobalHistory 를 React 없이 부른다(closeWindow.test.ts 와 같은 방식). effect 는 바로 실행하고, atom 에 쓰는 값을 모은다.
  const written = new Map<unknown, unknown>();
  const stub = (specifier: string, exports: object) => {
    const filename = require.resolve(specifier);
    require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
  };
  stub("react", { ...React, useEffect: (fn: () => void) => fn(), useRef: <T,>(current: T) => ({ current }), useCallback: (fn: unknown) => fn });
  stub("jotai", { ...jotai, useAtomValue: () => history, useSetAtom: (atom: unknown) => (value: unknown) => written.set(atom, value) });
  const { useGlobalHistory } = await import("src/features/setup/hooks/useGlobalHistory");
  let flushed = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 붙이는 리스너만 확인한다
  useGlobalHistory(() => flushed++);

  const events: HistoryEvent[] = [];
  history.addRenderListener((e) => events.push(e));
  history.setActiveSketch(null);
  assert.deepEqual(events, ["sketch"]);
  assert.equal(written.get(setupGlobalCanUndoAtom), false);
  assert.equal(written.get(setupGlobalCanRedoAtom), false);
  assert.equal(flushed, 0);

  history.setActiveSketch("XY");
  assert.equal(written.get(setupGlobalCanUndoAtom), true);
});
