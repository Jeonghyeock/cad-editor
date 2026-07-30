import { parse, stringify } from "flatted";
import { useSetAtom, useStore } from "jotai";
import { merge } from "lodash";
import { useCallback } from "react";

import { ConfigChannels } from "src/app/channels/configChannels";

import { INITIAL_CONFIG_DATA } from "src/shared/constants/Config.constant";
import { configDataAtom } from "src/shared/stores/Config.store";
import type { ConfigData } from "src/shared/types/Config.type";

export const useConfigFileActions = () => {
  const store = useStore();
  const setConfigData = useSetAtom(configDataAtom);

  const initializeConfigFile = useCallback(async () => {
    try {
      const configFileContent: string = await electron.ipcRenderer.invoke(
        ConfigChannels.GET_CONFIG_FILE,
      );

      const configData: ConfigData = merge(
        {},
        INITIAL_CONFIG_DATA,
        parse(configFileContent),
      );

      setConfigData(configData);
      // i18next 동기화는 별도 useI18nLanguageSync hook (AppContainer) 이 atom 구독으로 처리.
    } catch {
      return;
    }
  }, [setConfigData]);

  const saveConfigFile = useCallback(async () => {
    const configData = store.get(configDataAtom);
    const configFileContent = stringify(configData);

    await electron.ipcRenderer.invoke(
      ConfigChannels.SAVE_CONFIG_FILE,
      configFileContent,
    );
  }, [store]);

  return {
    initializeConfigFile,
    saveConfigFile,
  };
};
