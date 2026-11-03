import { app, BrowserWindow } from "electron";
import electronSquirrelStartup from "electron-squirrel-startup";

import { spawnSync } from "child_process";

import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";

import { createAppWindow } from "./appWindow";
import { installReactDevTools } from "./devTools";
import { sendOpenFile } from "./sendOpenFile";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

/**
 * Windows: .cad 파일 연결을 레지스트리에 등록/해제
 */
const registerCadFileAssociation = () => {
  if (process.platform !== "win32" || !app.isPackaged) return;

  const openCommand = `"${process.execPath}" "%1"`;

  spawnSync("reg", [
    "add",
    "HKCU\\Software\\Classes\\.cad",
    "/ve",
    "/d",
    "CadEditor.File",
    "/f",
  ]);
  spawnSync("reg", [
    "add",
    "HKCU\\Software\\Classes\\CadEditor.File",
    "/ve",
    "/d",
    "CAD Editor Project File",
    "/f",
  ]);
  spawnSync("reg", [
    "add",
    "HKCU\\Software\\Classes\\CadEditor.File\\shell\\open\\command",
    "/ve",
    "/d",
    openCommand,
    "/f",
  ]);
  spawnSync("reg", [
    "add",
    "HKCU\\Software\\Classes\\CadEditor.File\\DefaultIcon",
    "/ve",
    "/d",
    `"${process.execPath}",0`,
    "/f",
  ]);
};

const unregisterCadFileAssociation = () => {
  if (process.platform !== "win32") return;

  spawnSync("reg", ["delete", "HKCU\\Software\\Classes\\.cad", "/f"]);
  spawnSync("reg", ["delete", "HKCU\\Software\\Classes\\CadEditor.File", "/f"]);
};

// Squirrel 설치/제거 이벤트 처리
if (process.platform === "win32") {
  const squirrelEvent = process.argv[1];

  if (
    squirrelEvent === "--squirrel-install" ||
    squirrelEvent === "--squirrel-updated"
  ) {
    registerCadFileAssociation();
  } else if (squirrelEvent === "--squirrel-uninstall") {
    unregisterCadFileAssociation();
  }
}

if (electronSquirrelStartup) {
  app.quit();
}

/**
 * 단일 인스턴스 잠금: 이미 실행 중이면 두 번째 인스턴스는 종료
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  let isAppWindowCreated = false;
  let appWindow: BrowserWindow | null = null;
  // 창이 생기기 전(macOS 콜드 스타트)에 open-file 로 받은 경로. whenReady 에서 창을 만든 뒤 연다.
  const pendingFilePaths: string[] = [];

  /**
   * 안전하게 app window를 생성하고, 중복 방지
   */
  const ensureAppWindow = (): BrowserWindow => {
    if (!isAppWindowCreated) {
      appWindow = createAppWindow();
      isAppWindowCreated = true;
    }
    return appWindow!;
  };

  /**
   * 실행 중인 창을 앞으로 가져오고 파일을 연다
   */
  const openFileInAppWindow = (filePath?: string) => {
    if (!appWindow) return;

    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.focus();

    if (filePath) sendOpenFile(appWindow.webContents, filePath);
  };

  /**
   * Windows/Linux: 앱이 이미 실행 중일 때 .cad 파일 더블클릭 시
   */
  app.on("second-instance", (_event, commandLine) => {
    openFileInAppWindow(commandLine.find((arg) => arg.endsWith(".cad")));
  });

  /**
   * macOS: .cad 파일 더블클릭으로 실행할 때와 이미 실행 중일 때
   */
  app.on("open-file", (event, filePath) => {
    event.preventDefault();

    // 창이 생기기 전(콜드 스타트)이면 whenReady 가 창을 만든 뒤 한 번만 연다. 이미 실행 중이면 second-instance 와
    // 같이 연다 — 예전처럼 ready-to-show 를 기다리면 이미 지나간 이벤트라 열리지 않았다.
    if (!appWindow) {
      pendingFilePaths.push(filePath);
      return;
    }

    openFileInAppWindow(filePath);
  });

  /**
   * 일반 앱 실행 흐름
   */
  app.whenReady().then(async () => {
    // 무설치 버전에서도 .cad 파일 연결이 동작하도록 매 실행 시 등록
    registerCadFileAssociation();

    const cliFilePath = process.argv.find((arg) => arg.endsWith(".cad"));

    const win = ensureAppWindow();

    const filePaths = pendingFilePaths.length
      ? pendingFilePaths
      : [cliFilePath].filter(Boolean);
    if (filePaths.length) {
      win.webContents.once("did-finish-load", () => {
        for (const filePath of filePaths) {
          win.webContents.send(
            MenuChannels.MENU_EVENT,
            FileChannels.OPEN_FILE,
            filePath,
          );
        }
      });
    }

    // DevTools 확장 — 패키징하지 않은 개발 실행에서만. 배포판이 시작할 때 Google 에서 확장을 내려받아
    // 프로덕션 세션에 싣지 않도록(README '모두 로컬') 막고, 동적 import 로 main 번들에서도 뺀다(devTools.ts).
    if (!app.isPackaged) {
      installReactDevTools()
        .then((name) => console.info(`Added Extension: ${name}`)) // eslint-disable-line
        .catch((err) => console.info("An error occurred: ", err)); // eslint-disable-line
    }
  });

  /**
   * macOS Dock 클릭 시 창 다시 열기
   */
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      appWindow = createAppWindow();
    } else {
      BrowserWindow.getAllWindows()[0].show();
    }
  });

  /**
   * 모든 창이 닫혔을 때 동작 (mac은 앱 유지)
   */
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
