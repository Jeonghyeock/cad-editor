import { INITIAL_SETUP_DATA } from "src/features/setup/Setup.constant";
import type { SetupPersistentData } from "src/features/setup/Setup.type";

import { INITIAL_GLOBAL_DATA } from "src/shared/constants/File.constant";
import type {
  FileContent,
  PersistentData,
} from "src/shared/types/File.type";

/**
 * PersistentData를 FileContent로 변환
 */
export const convertFileDataToFileContent = (
  fileId: string,
  preview: string,
  persistentData: PersistentData,
): FileContent => ({
  fileId,
  preview,
  ...persistentData,
});

/**
 * 구버전 .mth 파일의 input 데이터를 현재 SetupPersistentData 스키마로 맞춤.
 * 누락 필드는 INITIAL_INPUT_DATA로 채워 atom들이 optional chain 없이 접근 가능하도록 보장.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalizeSetupData = (raw: any): SetupPersistentData => ({
  ...INITIAL_SETUP_DATA,
  ...(raw ?? {}),
  viewState: {
    ...INITIAL_SETUP_DATA.viewState,
    ...(raw?.viewState ?? {}),
  },
  visibility: {
    ...INITIAL_SETUP_DATA.visibility,
    ...(raw?.visibility ?? {}),
  },
});

/**
 * FileContent를 PersistentData로 변환. 누락/손상 필드는 INITIAL 로 방어.
 */
export const convertFileContentToPersistentData = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileContent: any,
): PersistentData => {
  const fc = fileContent ?? {};
  return {
    unit: fc.unit ?? INITIAL_GLOBAL_DATA.unit,
    lastURL: fc.lastURL ?? INITIAL_GLOBAL_DATA.lastURL,
    setup: normalizeSetupData(fc.setup),
  };
};
