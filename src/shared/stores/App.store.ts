import { atom } from "jotai";

import type { ContextMenuItem } from "src/components/ContextMenu";

import { INITIAL_CONTEXT_MENU } from "src/shared/constants/App.constant";

export const contextMenuAtom = atom<{
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}>(INITIAL_CONTEXT_MENU);

// LLM side panel open/close — mockup html .llm-panel 정합. mode-tab row 의 LLM 버튼이
// 토글. 본문은 껍데기 (chat UI placeholder).
export const llmPanelOpenAtom = atom<boolean>(false);
