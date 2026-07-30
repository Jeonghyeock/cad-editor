import { BrowserWindow, nativeImage } from "electron";

import path from "path";

import type { APP_PATH } from "src/shared/constants/App.constant";

interface CreatePageWindow extends Electron.BrowserWindowConstructorOptions {
  url: (typeof APP_PATH)[keyof typeof APP_PATH];
  isWindowUrl?: boolean;
}

/**
 * Create Page Window
 * @param { CreatePageWindow } options - Page Window Options
 * @returns { BrowserWindow } Application Window Instance
 */
export const createPageWindow = ({
  url,
  isWindowUrl = true,
  minWidth = 800,
  minHeight = 720,
  ...options
}: CreatePageWindow): BrowserWindow => {
  let pageWindow: BrowserWindow;

  const windowURL = isWindowUrl ? `/window${url}` : url;

  const iconPath =
    process.platform === "win32"
      ? path.join(__dirname, "../assets/favicon.ico")
      : path.join(__dirname, "../assets/logo.png");

  const pageOptions: Electron.BrowserWindowConstructorOptions = {
    ...options,
    width: options.width || minWidth,
    height: options.height || minHeight,
    minWidth,
    minHeight,
    modal: false,
    parent: null,
    show: true,
    transparent: options.transparent ?? false,
    hasShadow: options.hasShadow ?? true,
    icon: nativeImage.createFromPath(iconPath),
    // titleBarStyle: 'customButtonsOnHover',
    // visualEffectState: 'active',
    // vibrancy: 'popover',
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: options.backgroundColor ?? (options.transparent ? "#00000000" : "#fff"),
    webPreferences: {
      ...(options.webPreferences || {}),
      // appWindow 와 동일 보안 정책 — splash 등 보조 창도 renderer 가 Node API 직접 접근
      // 못 하도록. preload.ts 의 contextBridge.exposeInMainWorld 가 isolated world 에서
      // 안전한 IPC API 제공.
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      preload: path.join(__dirname, "preload.js"),
    },
  };

  if (process.platform === "darwin") {
    pageOptions.titleBarStyle = "hidden";
  }

  pageWindow = new BrowserWindow(pageOptions);

  pageWindow.center();

  const pageURL = `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/#${windowURL}`;

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    pageWindow?.loadURL(pageURL);
  } else {
    pageWindow?.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: windowURL },
    );
  }

  pageWindow.on("ready-to-show", () => {
    pageWindow?.show();
  });

  pageWindow.on("close", () => {
    pageWindow = null;
  });

  return pageWindow;
};
