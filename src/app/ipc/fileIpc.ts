import { BrowserWindow, ipcMain } from "electron";

import { FileChannels } from "src/app/channels/fileChannels";

import type { FileContent } from "src/shared/types/File.type";

import fileIpcUtil from "./fileIpcUtil";

export const registerFileIpc = () => {
  ipcMain.handle(FileChannels.GET_FILE_ID, async () => {
    return fileIpcUtil.getFileId();
  });

  ipcMain.handle(FileChannels.SET_FILE_ID, async (_event, fileId: string) => {
    return fileIpcUtil.setFileId(fileId);
  });

  ipcMain.handle(FileChannels.GET_OPEN_FILE_LIST, async () => {
    return fileIpcUtil.getOpenFileList();
  });

  ipcMain.handle(FileChannels.CREATE_FILE, async () => {
    return fileIpcUtil.createOpenFilePath();
  });

  ipcMain.handle(
    FileChannels.SAVE_FILE,
    async (_event, fileId: string, fileContent: FileContent) => {
      return fileIpcUtil.saveFile(fileId, fileContent);
    },
  );

  ipcMain.handle(
    FileChannels.SAVE_AS_FILE,
    async (_event, fileId: string, fileContent: FileContent) => {
      return fileIpcUtil.saveAsFile(fileId, fileContent);
    },
  );

  ipcMain.handle(
    FileChannels.OPEN_FILE,
    async (_event, isCurrentFileModified = true, filePath?: string) => {
      return fileIpcUtil.openFile(isCurrentFileModified, filePath);
    },
  );

  ipcMain.handle(
    FileChannels.CLOSE_FILE,
    async (
      event,
      fileId: string,
      fileContent: FileContent,
      isModified: boolean,
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return fileIpcUtil.closeFile(window, fileId, fileContent, isModified);
    },
  );

};
