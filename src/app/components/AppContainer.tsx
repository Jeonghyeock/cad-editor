import { useSetAtom, useStore } from "jotai";
import type React from "react";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useConfigFileActions } from "src/shared/hooks/useConfigFileActions";
import { useFileActions } from "src/shared/hooks/useFileActions";
import { useI18nLanguageSync } from "src/shared/hooks/useI18nLanguageSync";
import { languageAtom } from "src/shared/stores/Config.store";
import {
  globalDataAtom,
  openFileListAtom,
} from "src/shared/stores/File.store";

import { FileChannels } from "../channels/fileChannels";
import { MenuChannels } from "../channels/menuChannels";

type AppContainerProps = {
  children: React.ReactNode;
};

const AppContainer = ({ children }: AppContainerProps) => {
  const location = useLocation();

  const store = useStore();

  const {
    setFileContentToFileData,
    setCurrentFileFromFileData,
    updateFileId,
    updateOpenFileList,
    createFileAction,
    openFileAction,
    saveFileAction,
    saveAsFileAction,
    closeWindowAction,
  } = useFileActions();
  const { initializeConfigFile, saveConfigFile } = useConfigFileActions();
  const setLanguage = useSetAtom(languageAtom);
  useI18nLanguageSync();

  useEffect(() => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      channel: string,
      ...args: any[]
    ) => {
      if (channel === FileChannels.SAVE_FILE) {
        saveFileAction();
        saveConfigFile();
      } else if (channel === FileChannels.SAVE_AS_FILE) {
        saveAsFileAction();
        saveConfigFile();
      } else if (channel === FileChannels.OPEN_FILE) {
        openFileAction(args[0]);
      } else if (channel === FileChannels.CREATE_FILE) {
        createFileAction();
      } else if (channel === MenuChannels.WINDOW_CLOSE) {
        closeWindowAction();
      } else if (channel === MenuChannels.SET_LANGUAGE_EN) {
        setLanguage("en");
        saveConfigFile();
      } else if (channel === MenuChannels.SET_LANGUAGE_KO) {
        setLanguage("ko");
        saveConfigFile();
      } else {
        electron.ipcRenderer.invoke(channel, ...args);
      }
    };

    electron.ipcRenderer.on(MenuChannels.MENU_EVENT, listener);
    return () => {
      electron.ipcRenderer.removeListener(MenuChannels.MENU_EVENT, listener);
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    const initializeApp = async () => {
      await initializeConfigFile();

      await updateOpenFileList();
      // updateRecentFileList() 호출 제거 — recentFileListAtom 이 어디서도 read 되지 않는
      // dead atom 인데, IPC handler 가 매 호출마다 최근 30 개 .cad 파일을 fs.readFileSync
      // + JSON.parse 로 hydrate 해 10 초 가까이 main process 를 block. recent 메뉴를 다시
      // 도입할 때 lazy load 또는 metadata-only 로 분리해 호출.
      await updateFileId();

      store.get(openFileListAtom).forEach((file) => {
        if (!file.fileContent) return;
        setFileContentToFileData(file);
      });

      setCurrentFileFromFileData();
    };

    initializeApp();
  }, []); // eslint-disable-line

  useEffect(() => {
    store.set(globalDataAtom, (prev) => ({
      ...prev,
      lastURL: location.pathname,
    }));
  }, [location.pathname]); // eslint-disable-line

  return children;
};

export default AppContainer;
