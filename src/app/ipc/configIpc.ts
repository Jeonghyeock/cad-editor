import { ipcMain } from "electron";

import { ConfigChannels } from "src/app/channels/configChannels";
import configIpcUtil from "src/app/ipc/configIpcUtil";

export const registerConfigIpc = () => {
  ipcMain.handle(ConfigChannels.GET_CONFIG_FILE, (): string => {
    return configIpcUtil.getConfigFile();
  });

  ipcMain.handle(
    ConfigChannels.SAVE_CONFIG_FILE,
    (_, configFileContent: string) => {
      configIpcUtil.saveConfigFile(configFileContent);
    },
  );

};
