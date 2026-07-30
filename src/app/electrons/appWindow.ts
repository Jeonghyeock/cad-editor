import { app, BrowserWindow, Menu, nativeImage } from "electron";
import windowStateKeeper from "electron-window-state";

import path from "path";

import { MenuChannels } from "src/app/channels/menuChannels";
import { registerConfigIpc } from "src/app/ipc/configIpc";
import { registerFileIpc } from "src/app/ipc/fileIpc";
import { registerMenuIpc } from "src/app/ipc/menuIpc";
import { registerOcctIpc } from "src/app/ipc/occtIpc";
import { registerWindowIpc } from "src/app/ipc/windowIpc";

import {
  APP_MENU_OPTIONS,
  APP_PATH,
  WINDOW_SIZE,
} from "src/shared/constants/App.constant";

import { createPageWindow } from "./pageWindow";
import { registerWindowStateChangedEvents } from "./windowState";

let appWindow: BrowserWindow;
let splashWindow: BrowserWindow;

// before-quit 은 app 전역 이벤트라 한 번만 등록.
let _isQuitting = false;
app.on("before-quit", () => {
  _isQuitting = true;
});
let splashTimeout: NodeJS.Timeout | null = null;
let isWindowShown = false;

/**
 * Create Application Window
 * @returns { BrowserWindow } Application Window Instance
 */
export const createAppWindow = (): BrowserWindow => {
  const minWidth = WINDOW_SIZE.MAIN.width;
  const minHeight = WINDOW_SIZE.MAIN.height;

  const savedWindowState = windowStateKeeper({
    defaultWidth: minWidth,
    defaultHeight: minHeight,
    maximize: false,
  });

  const iconPath =
    process.platform === "win32"
      ? path.join(__dirname, "../assets/favicon.ico")
      : path.join(__dirname, "../assets/logo.png");

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    x: savedWindowState.x,
    y: savedWindowState.y,
    width: savedWindowState.width,
    height: savedWindowState.height,
    minWidth: minWidth,
    minHeight: minHeight,
    autoHideMenuBar: true,
    transparent: false,
    hasShadow: true,
    frame: false,
    show: false,
    // titleBarStyle: 'customButtonsOnHover',
    // visualEffectState: 'active',
    // vibrancy: 'popover',
    icon: nativeImage.createFromPath(iconPath),
    backgroundColor: "#fff",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      preload: path.join(__dirname, "preload.js"),
    },
  };

  if (process.platform === "darwin") {
    windowOptions.titleBarStyle = "hidden";
  }

  // 새 윈도우 인스턴스 생성
  appWindow = new BrowserWindow(windowOptions);

  // 앱 윈도우의 index.html 로드.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    appWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    appWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // 애플리케이션 메뉴 빌드
  const menu = Menu.buildFromTemplate(APP_MENU_OPTIONS);
  Menu.setApplicationMenu(menu);

  splashWindow = createPageWindow({
    url: APP_PATH.SPLASH,
    isWindowUrl: false,
    minWidth: WINDOW_SIZE.SPLASH.width,
    minHeight: WINDOW_SIZE.SPLASH.height,
    closable: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    show: true,
    transparent: true,
    hasShadow: false,
    icon: path.join(__dirname, "../assets/favicon.ico"),
  });

  appWindow.on("ready-to-show", async () => {
    if (splashTimeout) {
      clearTimeout(splashTimeout);
      splashTimeout = null;
    }

    const minSplashTime = new Promise((resolve) => setTimeout(resolve, 2000));

    await minSplashTime;

    if (!isWindowShown) {
      isWindowShown = true;
      appWindow.maximize();
      appWindow.show();
    }

    if (splashWindow) {
      splashWindow.destroy();
      splashWindow = null;
    }
  });

  registerMainIPC();

  savedWindowState.manage(appWindow);

  // before-quit 은 app (전역) 이벤트라 모듈 레벨 isQuitting 으로 createAppWindow 중복 호출 시
  // listener 누적 방지. window 별 close 핸들러는 새 window 마다 등록.
  appWindow.on("close", async (e) => {
    if (_isQuitting) return;

    e.preventDefault();
    appWindow.webContents.send(
      MenuChannels.MENU_EVENT,
      MenuChannels.WINDOW_CLOSE,
    );
  });

  appWindow.on("closed", () => {
    if (splashTimeout) {
      clearTimeout(splashTimeout);
      splashTimeout = null;
    }

    if (splashWindow) {
      splashWindow.destroy();
    }

    splashWindow = null;
  });

  return appWindow;
};

// IPC handler 들은 모듈 레벨로 한 번만 등록 — createAppWindow 가 두 번 이상 호출되어도
// (macOS dock 재활성화 등) 중복 등록 안 함. ipcMain.handle 은 같은 channel 두 번 시 throw,
// ipcMain.on / app.on 은 listener 누적으로 MaxListenersExceededWarning 발생.
let _ipcRegistered = false;

/**
 * Register Inter Process Communication
 */
const registerMainIPC = () => {
  // window state events 는 window 인스턴스에 등록되므로 매 createAppWindow 마다 재등록.
  // (window 객체가 새로워서 listener 누적 안 됨)
  registerWindowStateChangedEvents(appWindow);
  if (_ipcRegistered) return;
  _ipcRegistered = true;
  /**
   * Here you can assign IPC related codes for the application window
   * to Communicate asynchronously from the main process to renderer processes.
   */
  registerConfigIpc();
  registerMenuIpc();
  registerFileIpc();
  registerWindowIpc();
  registerOcctIpc();
};
