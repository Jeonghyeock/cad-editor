import { useAtomValue } from "jotai";
import { useEffect } from "react";

import i18n from "src/shared/i18n";
import { languageAtom } from "src/shared/stores/Config.store";

/**
 * languageAtom ↔ i18next 동기화 — Config.store 는 순수 상태, 이 hook 이 side-effect 담당.
 * AppContainer 에서 한 번 호출. atom 변경 (메뉴 클릭 / disk 복원 모두) 시 i18n.changeLanguage 발동.
 */
export const useI18nLanguageSync = (): void => {
  const language = useAtomValue(languageAtom);
  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [language]);
};
