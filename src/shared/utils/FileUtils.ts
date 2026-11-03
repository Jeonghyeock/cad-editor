import { merge } from "lodash";

import { GlobalHistoryManager } from "src/features/setup/core/GlobalHistoryManager";
import {
  INITIAL_SETUP_DATA,
  cloneSetupData,
} from "src/features/setup/Setup.constant";
import type { SetupPersistentData } from "src/features/setup/Setup.type";

import { INITIAL_GLOBAL_DATA } from "src/shared/constants/File.constant";
import type {
  FileContent,
  FileData,
  GlobalData,
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

/**
 * 디스크에서 읽은 FileContent 로 파일 하나의 FileData(globalData + originData) 를 만든다.
 *
 * lodash.merge 는 클래스 인스턴스를 참조로 복사한다. 그대로 두면 디스크에서 연 파일들이
 * INITIAL_SETUP_DATA 의 globalHistory 하나를 같이 써서, 한 파일의 undo 가 다른 파일에 적용된다.
 * 화면이 그 이력을 구독(리스너 함수 등록)한 뒤에는 다음 파일의 originData 를 structuredClone 하다
 * DataCloneError 가 나, 빈 문서가 뜨고 저장하면 원본을 빈 내용으로 덮어썼다. 파일마다 새 인스턴스를 넣는다.
 */
export const createFileData = (
  fileId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileContent: any,
): FileData => {
  // ⚠️ lodash.merge 는 배열을 인덱스 단위 깊이 병합 — INITIAL_GLOBAL_DATA 의 배열이
  // 비어있는 동안은 OK 지만, 향후 INITIAL 에 배열 default item 이 추가되면 persistentData
  // 의 동일 인덱스 항목과 의도치 않은 깊이 병합이 발생할 수 있음. 그 경우 배열 필드는
  // structuredClone 으로 분리 처리하거나 lodash.mergeWith 의 array customizer 사용.
  const merged: GlobalData = merge(
    {},
    INITIAL_GLOBAL_DATA,
    convertFileContentToPersistentData(fileContent),
  );
  const globalData: GlobalData = {
    ...merged,
    setup: { ...merged.setup, globalHistory: new GlobalHistoryManager() },
  };

  // originData 는 deep clone — globalData 의 nested mutation 이 originData 에 누수
  // 되는 것 방지. isModified deep compare 정확성 보장. setup 은 cloneSetupData (globalHistory 제외).
  const { setup, ...rest } = globalData;
  return {
    fileId,
    globalData,
    originData: { ...structuredClone(rest), setup: cloneSetupData(setup) },
  };
};
