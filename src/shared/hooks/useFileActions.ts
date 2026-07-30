import { useStore } from "jotai";
import { merge } from "lodash";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";

import { setupFlushSyncAtom } from "src/features/setup/Setup.store";

import { APP_PATH } from "src/shared/constants/App.constant";
import { INITIAL_GLOBAL_DATA } from "src/shared/constants/File.constant";
import {
  fileIdAtom,
  fileDataAtomFamily,
  openFileListAtom,
  fileDataAtom,
  isModifiedAtomFamily,
  markFileCleanAtom,
} from "src/shared/stores/File.store";
import type { CadFile, GlobalData } from "src/shared/types/File.type";
import { extractPersistentData } from "src/shared/utils/ExtractDataUtils";
import {
  convertFileContentToPersistentData,
  convertFileDataToFileContent,
} from "src/shared/utils/FileUtils";

export const useFileActions = () => {
  const navigate = useNavigate();

  const store = useStore();

  // input feature 의 imperative state → globalData 동기화는 useGlobalHistory 의 onHistoryChange
  // 가 매 history command (사용자 의도 단위) 마다 자동 처리. 따라서 file action 직전 명시 flush
  // 불필요 — globalData 가 이미 최신.

  // globalData 의 models 가 이미 SerializedStepModelData[] (base64) 라 별도 encoding 불필요 —
  // extractPersistentData 만 사용.
  const extractPersistentDataWithEncoding = useCallback(
    (globalData: GlobalData) => extractPersistentData(globalData),
    [],
  );

  // 파일 썸네일 preview — 현재 에디터에선 미생성 (빈 문자열).
  const generatePreview = useCallback((): string => "", []);

  /**
   * 파일 ID를 업데이트합니다.
   */
  const updateFileId = useCallback(async () => {
    const fileId = await electron.ipcRenderer.invoke(FileChannels.GET_FILE_ID);
    store.set(fileIdAtom, fileId);
  }, [store]);

  /**
   * 열려있는 파일 목록을 업데이트합니다.
   */
  const updateOpenFileList = useCallback(async () => {
    const prevOpenFileList = store.get(openFileListAtom);
    const openFileList: CadFile[] = await electron.ipcRenderer.invoke(
      FileChannels.GET_OPEN_FILE_LIST,
    );

    prevOpenFileList.forEach((file) => {
      if (!openFileList.find((f) => f.fileId === file.fileId)) {
        fileDataAtomFamily.remove(file.fileId);
        // isModifiedAtomFamily 는 fileDataAtomFamily 를 구독하는 derived atom 패밀리 —
        // fileDataAtomFamily.remove 만 호출하면 인스턴스가 남아 파일 열고 닫을 때마다 누적.
        isModifiedAtomFamily.remove(file.fileId);
      }
    });

    store.set(openFileListAtom, openFileList);
  }, [store]);

  /**
   * 파일의 내용을 fileDataAtomFamily에 설정합니다.
   * @param file 파일 정보 (생략 시 현재 활성화된 파일 사용)
   */
  const setFileContentToFileData = useCallback(
    (file?: CadFile) => {
      if (!file) {
        file = store
          .get(openFileListAtom)
          .find((file) => file.fileId === store.get(fileIdAtom));
      }

      if (!file || !file.fileContent) return;

      const persistentData = convertFileContentToPersistentData(
        file.fileContent,
      );
      // ⚠️ lodash.merge 는 배열을 인덱스 단위 깊이 병합 — INITIAL_GLOBAL_DATA 의 배열이
      // 비어있는 동안은 OK 지만, 향후 INITIAL 에 배열 default item 이 추가되면 persistentData
      // 의 동일 인덱스 항목과 의도치 않은 깊이 병합이 발생할 수 있음. 그 경우 배열 필드는
      // structuredClone 으로 분리 처리하거나 lodash.mergeWith 의 array customizer 사용.
      const targetData: GlobalData = merge(
        {},
        INITIAL_GLOBAL_DATA,
        persistentData,
      );

      // globalData.setup.models 는 serialized form (base64) 그대로 보유 — decode 안 함.
      // runtime form (number[]) 은 setupModelsAtom (transient) 가 별도 보유 — input/index.tsx
      // 의 file load effect 에서 deserializeStepModels 호출 후 atom 채움.

      // originData 는 deep clone — globalData 의 nested mutation 이 originData 에 누수
      // 되는 것 방지. isModified deep compare 정확성 보장.
      store.set(fileDataAtomFamily(file.fileId), {
        fileId: file.fileId,
        globalData: targetData,
        originData: structuredClone(targetData),
      });

      // inputDefinitionRequestedAtom은 globalData에서 derived — 별도 설정 불필요
    },
    [store],
  );

  /**
   * 현재 파일의 데이터를 기반으로 local 상태를 설정합니다.
   */
  const setCurrentFileFromFileData = useCallback(() => {
    const {
      globalData: { lastURL },
    } = store.get(fileDataAtom);

    const nextURL = lastURL || APP_PATH.INPUT;
    navigate(nextURL);
  }, [navigate, store]);

  /**
   * 파일을 활성화합니다.
   * @param fileId 파일 ID
   */
  const activateFileAction = useCallback(
    async (fileId: string) => {
      await electron.ipcRenderer.invoke(FileChannels.SET_FILE_ID, fileId);
      await updateFileId();

      setCurrentFileFromFileData();
    },
    [updateFileId, setCurrentFileFromFileData],
  );

  /**
   * 새 파일을 생성합니다.
   */
  const createFileAction = useCallback(async () => {
    await electron.ipcRenderer.invoke(FileChannels.CREATE_FILE);
    await updateOpenFileList();
    await updateFileId();

    setFileContentToFileData();
    setCurrentFileFromFileData();
  }, [
    setCurrentFileFromFileData,
    setFileContentToFileData,
    updateFileId,
    updateOpenFileList,
  ]);

  /**
   * 파일을 저장합니다.
   * @param fileId 파일 ID (생략 시 현재 활성화된 파일 사용)
   */
  const saveFileAction = useCallback(
    async (fileId?: string) => {
      if (!fileId) {
        fileId = store.get(fileIdAtom);
      }

      // 활성 sketch 가 있다면 그 변경 (EE 회전 / 좌표 mutation 등) 을 globalData.setup.sketches
      // 에 flush. history listener 가 매 command 후 flushInputSync 호출하지만 함수 직접 호출
      // (예: rotateShape) 은 command 가 아니라 누락 가능. file save 직전에 강제 flush 로 보장.
      store.get(setupFlushSyncAtom)?.();

      const { globalData } = store.get(fileDataAtomFamily(fileId));

      const preview = generatePreview();
      const persistentData = extractPersistentDataWithEncoding(globalData);
      const fileContent = convertFileDataToFileContent(
        fileId,
        preview,
        persistentData,
      );

      const res: boolean = await electron.ipcRenderer.invoke(
        FileChannels.SAVE_FILE,
        fileId,
        fileContent,
      );

      if (!res) return;

      await updateOpenFileList();
      // updateRecentFileList() 호출 제거 — recent atom 이 dead 인데 IPC 가 30 개 파일을
      // fs.readFileSync + JSON.parse 로 hydrate 해 main process 를 수 초 block. recent 메뉴
      // 다시 도입 시 metadata-only IPC 또는 lazy load 로 분리해 호출.

      // save 후 globalData 는 이미 최신. originData 만 동기화해 dirty flag 를 clean 으로.
      // markFileCleanAtom 이 deep clone 으로 originData 분리 — globalData mutation 누수 방지.
      store.set(markFileCleanAtom, fileId);
    },
    [
      store,
      extractPersistentDataWithEncoding,
      generatePreview,
      updateOpenFileList,
    ],
  );

  /**
   * 파일을 다른 이름으로 저장합니다.
   */
  const saveAsFileAction = useCallback(async () => {
    // 활성 sketch flush (saveFileAction 와 동일 — EE 회전 등 직접 mutation lost 방지).
    store.get(setupFlushSyncAtom)?.();
    const { fileId, globalData } = store.get(fileDataAtom);

    const preview = generatePreview();
    const persistentData = extractPersistentDataWithEncoding(globalData);
    const fileContent = convertFileDataToFileContent(
      fileId,
      preview,
      persistentData,
    );

    const res: boolean = await electron.ipcRenderer.invoke(
      FileChannels.SAVE_AS_FILE,
      fileId,
      fileContent,
    );

    if (!res) return;

    await updateOpenFileList();
    // updateRecentFileList() 제거 — dead atom + 무거운 IPC.
    await updateFileId();

    setFileContentToFileData();
    store.set(markFileCleanAtom, store.get(fileIdAtom));
  }, [
    store,
    extractPersistentDataWithEncoding,
    generatePreview,
    updateOpenFileList,
    updateFileId,
    setFileContentToFileData,
  ]);

  /**
   * 파일을 엽니다.
   * @param filePath 파일 경로 (생략 시 파일 선택 다이얼로그 표시)
   * @returns 파일이 실제로 열렸으면 true, dialog 에서 cancel 또는 실패 시 false.
   */
  const openFileAction = useCallback(
    async (filePath?: string): Promise<boolean> => {
      const fileId = store.get(fileIdAtom);
      const isModified = store.get(isModifiedAtomFamily(fileId));
      const res: boolean = await electron.ipcRenderer.invoke(
        FileChannels.OPEN_FILE,
        isModified,
        filePath,
      );

      if (!res) return false;

      await updateOpenFileList();
      // updateRecentFileList() 제거 — dead atom + 무거운 IPC.
      await updateFileId();

      setFileContentToFileData();
      setCurrentFileFromFileData();
      return true;
    },
    [
      setCurrentFileFromFileData,
      setFileContentToFileData,
      store,
      updateFileId,
      updateOpenFileList,
    ],
  );

  /**
   * 파일을 닫습니다.
   * @param fileId 파일 ID
   */
  const closeFileAction = useCallback(
    async (fileId: string) => {
      const { globalData } = store.get(fileDataAtomFamily(fileId));

      const preview = generatePreview();
      const persistentData = extractPersistentDataWithEncoding(globalData);
      const fileContent = convertFileDataToFileContent(
        fileId,
        preview,
        persistentData,
      );

      const isModified = store.get(isModifiedAtomFamily(fileId));
      const res: boolean = await electron.ipcRenderer.invoke(
        FileChannels.CLOSE_FILE,
        fileId,
        fileContent,
        isModified,
      );

      // 취소
      if (!res) return;

      await updateOpenFileList();
      // updateRecentFileList() 제거 — dead atom + 무거운 IPC.
      await updateFileId();

      setCurrentFileFromFileData();
    },
    [
      store,
      extractPersistentDataWithEncoding,
      generatePreview,
      updateOpenFileList,
      updateFileId,
      setCurrentFileFromFileData,
    ],
  );

  /**
   * 창을 닫습니다.
   */
  const closeWindowAction = useCallback(async () => {
    try {
      const openFileList = store.get(openFileListAtom);
      // 모든 열린 파일에 대해 미저장 변경 시 closeFileAction (저장 확인 dialog).
      // 이전엔 i > 0 으로 첫 파일을 skip 했지만 첫 파일도 변경 사항 있을 수 있어 i >= 0 으로 수정.
      for (let i = openFileList.length - 1; i >= 0; i--) {
        const file = openFileList[i];
        const isModified = store.get(isModifiedAtomFamily(file.fileId));
        if (!isModified) continue;

        await closeFileAction(file.fileId);
      }
    } finally {
      electron.ipcRenderer.invoke(MenuChannels.WINDOW_CLOSE);
    }
  }, [store, closeFileAction]);

  return {
    setFileContentToFileData,
    setCurrentFileFromFileData,
    updateFileId,
    updateOpenFileList,
    activateFileAction,
    createFileAction,
    saveFileAction,
    saveAsFileAction,
    openFileAction,
    closeFileAction,
    closeWindowAction,
  };
};
