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
 * globalData 의 deep clone — 저장할 때 디스크에 쓰는 내용을 떠 두는 데 쓴다.
 * setup 만 cloneSetupData (globalHistory 등 non-cloneable 회피).
 */
export const cloneGlobalData = (globalData: GlobalData): GlobalData => {
  const { setup, ...rest } = globalData;
  return {
    ...structuredClone(rest),
    setup: cloneSetupData(setup),
  };
};

/**
 * file 의 dirty flag 를 clean 으로 — originData 를 디스크에 쓴 내용(savedData)으로 맞춘다.
 * savedData 는 저장 IPC 를 보내기 전에 cloneGlobalData 로 떠 둔 사본이다. 저장이 끝난 시점의 globalData 로
 * 맞추면 저장하는 동안 한 편집까지 clean 이 되어, 그 탭을 닫을 때 확인창 없이 사라진다.
 */
export const markFileCleanAtom = atom(
  null,
  (_get, set, fileId: string, savedData: GlobalData) => {
    set(fileDataAtomFamily(fileId), (prev) => ({
      ...prev,
      originData: savedData,
    }));
  },
);

export const isModifiedAtomFamily = atomFamily((fileId: string) =>
  atom((get) => {
    const { globalData, originData } = get(fileDataAtomFamily(fileId));
    return !isEqual(
      extractComparableData(globalData),
      extractComparableData(originData),
    );
  }),
);
