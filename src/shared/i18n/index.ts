// i18next instance — 사용자 보이는 dialog / toast / 진단 메시지 영어/한국어 토글.
// 일반 UI label (button, tooltip, aria-label) 은 영어 고정 — 토글 범위 아님.
// 언어 설정은 Config (cad-editor.config.json) 에 persist, View → Language 메뉴에서 전환.

// i18next 패키지의 default export 가 named import 와 겹쳐 ESLint 가 경고 — i18next 공식
// 사용법이라 disable.
// eslint-disable-next-line import/no-named-as-default
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import ko from "./locales/ko.json";

// eslint-disable-next-line import/no-named-as-default-member
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ko: { translation: ko },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;

// returnNull:false 런타임 옵션 효과를 t() 반환 타입에도 반영 — t("key") 가 string | null
// 이 아닌 string 으로 추론되어 JSX 에 직접 삽입 시 타입 충돌 없음.
declare module "i18next" {
  interface CustomTypeOptions {
    returnNull: false;
  }
}
