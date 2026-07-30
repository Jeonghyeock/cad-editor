import { app, BrowserWindow, ipcMain, Menu } from "electron";

import { MenuChannels } from "src/app/channels/menuChannels";

export const registerMenuIpc = () => {
  ipcMain.on(MenuChannels.EXECUTE_MENU_ITEM_BY_ID, (event, id) => {
    const currentMenu = Menu.getApplicationMenu();
    if (currentMenu === null) {
      return;
    }
    const menuItem = currentMenu.getMenuItemById(id);
    if (menuItem) {
      const window = BrowserWindow.fromWebContents(event.sender);
      menuItem.click(null, window, event.sender);
    }
  });

  ipcMain.handle(MenuChannels.WINDOW_MINIMIZE, (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    targetWindow?.minimize();
  });

  ipcMain.handle(MenuChannels.WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (targetWindow?.isMaximized()) {
      targetWindow?.unmaximize();
    } else {
      targetWindow?.maximize();
    }
  });

  ipcMain.handle(MenuChannels.WINDOW_CLOSE, (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const windows = BrowserWindow.getAllWindows();

    if (targetWindow) {
      targetWindow.destroy();
    }

    if (windows.length <= 1) {
      app.quit();
      return;
    }
  });

  ipcMain.handle(MenuChannels.WEB_TOGGLE_DEVTOOLS, (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    targetWindow?.webContents.toggleDevTools();
  });

  ipcMain.handle(MenuChannels.WEB_TOGGLE_FULLSCREEN, (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (targetWindow) {
      targetWindow?.setFullScreen(!targetWindow?.fullScreen);
    }
  });
};
