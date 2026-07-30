import type { WebContents } from "electron";

import { MenuChannels } from "src/app/channels/menuChannels";

export function emitEvent(
  eventName: string,
  ...args: any[]
): (
  menuItem: Electron.MenuItem,
  browserWindow: Electron.BrowserWindow | undefined,
  event: Electron.KeyboardEvent,
) => void {
  return (_, focusedWindow) => {
    const mainWindow =
      focusedWindow ?? Electron.BrowserWindow.getAllWindows()[0];
    if (mainWindow !== undefined) {
      sendToRenderer(
        mainWindow.webContents,
        MenuChannels.MENU_EVENT,
        eventName,
        ...args,
      );
    }
  };
}

export function sendToRenderer(
  webContents: WebContents,
  channel: string,
  ...args: any[]
): void {
  if (webContents.isDestroyed()) {
    const msg = `failed to send on ${channel}, webContents was destroyed`;
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
    console.error(msg); // eslint-disable-line
  } else {
    webContents.send(channel, ...args);
  }
}
