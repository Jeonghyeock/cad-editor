import { atom } from "jotai";

import type { CONFIG_UNIT } from "src/shared/constants/Config.constant";
import { INITIAL_CONFIG_DATA } from "src/shared/constants/Config.constant";
import type { AppLanguage } from "src/shared/types/Config.type";

import { globalDataAtom } from "./File.store";

export const configDataAtom = atom(INITIAL_CONFIG_DATA);

/**
 * Unit (단위계) — **파일별** 영속. globalDataAtom.unit 의 derived. 이전엔 configDataAtom
 * 의 글로벌 설정이었으나 다른 단위로 작업할 수 있도록 파일에 저장 (Welcome New Project
 * 시 설정 + AppStatusbar 의 dropdown 으로 변경).
 */
export const unitAtom = atom(
  (get) => get(globalDataAtom).unit,
  (
    get,
    set,
    update:
      | keyof typeof CONFIG_UNIT
      | ((prev: keyof typeof CONFIG_UNIT) => keyof typeof CONFIG_UNIT),
  ) => {
    const current = get(globalDataAtom).unit;
    const next = typeof update === "function" ? update(current) : update;
    set(globalDataAtom, (prev) => ({ ...prev, unit: next }));
  },
);

// Application language — View → Language 메뉴에서 설정. atom 은 순수 상태 — i18next 동기화는
// useI18nLanguageSync hook (AppContainer 마운트 시 한 번) 이 atom 구독 + side-effect 분리.
// disk persistence 는 useConfigFileActions 가 configDataAtom 전체를 저장.
export const languageAtom = atom(
  (get) => get(configDataAtom).language,
  (get, set, lang: AppLanguage) => {
    set(configDataAtom, { ...get(configDataAtom), language: lang });
  },
);
