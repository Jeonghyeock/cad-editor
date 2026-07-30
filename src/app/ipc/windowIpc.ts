import { ipcMain, BrowserWindow } from "electron";

import { WindowChannels } from "src/app/channels/windowChannels";

export const registerWindowIpc = () => {
  ipcMain.on(WindowChannels.INSPECT_ELEMENT, (_event, [x, y]) => {
    const win = BrowserWindow.getFocusedWindow();
    win?.webContents.inspectElement(x, y);
  });
};
