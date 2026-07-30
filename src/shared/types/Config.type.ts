export type AppLanguage = "en" | "ko";

// unit 은 파일별로 영속 (GlobalData.unit) — 글로벌 config 에서 제외.
export type ConfigData = {
  language: AppLanguage;
};
