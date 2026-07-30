import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { isEqual } from "lodash";

import { cloneSetupData, makeInitialSetupData } from "src/features/setup/Setup.constant";

import type {
  FileData,
  GlobalData,
  CadFile,
} from "src/shared/types/File.type";

import { INITIAL_GLOBAL_DATA } from "../constants/File.constant";
import { extractComparableData } from "../utils/ExtractDataUtils";

export const openFileListAtom = atom<CadFile[]>([]);
export const fileIdAtom = atom<string>("");

// 파일별 globalData — atomFamily 가 새 fileId 첫 access 시 factory 호출.
// setup transient 의 mutable instance (GlobalHistoryManager 등) 격리 위해 매 fileId 마다
// makeInitialSetupData() fresh instance 주입.
export const fileDataAtomFamily = atomFamily((fileId: string) =>
  atom<FileData>({
    fileId,
    globalData: {
      ...INITIAL_GLOBAL_DATA,
      setup: makeInitialSetupData(),
    },
    originData: INITIAL_GLOBAL_DATA,
  }),
);

export const fileDataAtom = atom(
  (get) => {
    const fileId = get(fileIdAtom);
    return get(fileDataAtomFamily(fileId));
  },
  (get, set, update: FileData | ((prev: FileData) => FileData)) => {
    const fileId = get(fileIdAtom);
    const target = fileDataAtomFamily(fileId);
    const prev = get(target);
    const fileData = typeof update === "function" ? update(prev) : update;
    set(target, fileData);
  },
);

export const globalDataAtom = atom(
  (get) => get(fileDataAtom).globalData,
  (get, set, update: GlobalData | ((prev: GlobalData) => GlobalData)) => {
    const fileData = get(fileDataAtom);
    const prev = fileData.globalData;
    const globalData = typeof update === "function" ? update(prev) : update;
    set(fileDataAtom, { ...fileData, globalData });
  },
);

/**
 * file 의 dirty flag 를 clean 으로 — originData 를 현재 globalData 의 deep clone 으로 동기화.
 * setup 만 cloneSetupData (globalHistory 등 non-cloneable 회피).
 */
export const markFileCleanAtom = atom(null, (_get, set, fileId: string) => {
  set(fileDataAtomFamily(fileId), (prev) => {
    const { setup, ...rest } = prev.globalData;
    const restCloned = structuredClone(rest);
    return {
      ...prev,
      originData: {
        ...restCloned,
        setup: cloneSetupData(setup),
      },
    };
  });
});

export const isModifiedAtomFamily = atomFamily((fileId: string) =>
  atom((get) => {
    const { globalData, originData } = get(fileDataAtomFamily(fileId));
    return !isEqual(
      extractComparableData(globalData),
      extractComparableData(originData),
    );
  }),
);
