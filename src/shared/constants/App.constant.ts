import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";
import { emitEvent } from "src/app/electrons/webContents";

export const APP_MENU_OPTIONS: Electron.MenuItemConstructorOptions[] = [
  {
    label: "File",
    submenu: [
      {
        id: FileChannels.CREATE_FILE,
        label: "New File",
        click: emitEvent(FileChannels.CREATE_FILE),
      },
      {
        id: FileChannels.SAVE_FILE,
        label: "Save File",
        accelerator: "CmdOrCtrl+S",
        click: emitEvent(FileChannels.SAVE_FILE),
      },
      {
        id: FileChannels.SAVE_AS_FILE,
        label: "Save As",
        accelerator: "CmdOrCtrl+Shift+S",
        click: emitEvent(FileChannels.SAVE_AS_FILE),
      },
      {
        id: FileChannels.OPEN_FILE,
        label: "Open File",
        accelerator: "CmdOrCtrl+O",
        click: emitEvent(FileChannels.OPEN_FILE),
      },
      { type: "separator" },
      {
        // role 을 두지 않는다. role:"quit" 이면 click 대신 app.quit() 이 바로 실행돼 저장 확인 없이 꺼진다
        // (제목표시줄 메뉴는 main 에서 menuItem.click() 을 부르는데, role 이 있으면 그쪽이 이긴다).
        id: MenuChannels.WINDOW_CLOSE,
        label: "Exit",
        accelerator: "CmdOrCtrl+Q",
        click: emitEvent(MenuChannels.WINDOW_CLOSE),
      },
    ],
  },
  {
    label: "View",
    submenu: [
      {
        id: MenuChannels.WEB_TOGGLE_DEVTOOLS,
        label: "Toogle Developer Tools",
        role: "toggleDevTools" as const,
        accelerator: "CmdOrCtrl+Shift+I",
      },
      { type: "separator" },
      {
        id: MenuChannels.SET_LANGUAGE_EN,
        label: "Language: English",
        click: emitEvent(MenuChannels.SET_LANGUAGE_EN),
      },
      {
        id: MenuChannels.SET_LANGUAGE_KO,
        label: "Language: 한국어",
        click: emitEvent(MenuChannels.SET_LANGUAGE_KO),
      },
    ],
  },
];

export const APP_PATH = {
  INPUT: "/",
  SPLASH: "/splash",
  // search → explore (rename 082): generative / optimize 결과를 탐색하는 페이지.
  EXPLORE: "/explore",
  // 결과 viewer:
  // - RESULT: T9.6 기반 — DMU Simulate / Optimization Run / Explore mechanism click /
  //   Generative Design Run 후 진입. LinkageEngine + trajectory / T09Doc + evaluate 기반
  //   시각화 + candidate list.
  RESULT: "/result",
  RESULT_GRAPH_WINDOW: "/result/graph",
};

export const WINDOW_SIZE = {
  MAIN: {
    width: 1280,
    height: 720,
  },
  SPLASH: {
    width: 220,
    height: 220,
  },
};

export const INITIAL_CONTEXT_MENU = {
  visible: false,
  x: 0,
  y: 0,
  items: [],
};
