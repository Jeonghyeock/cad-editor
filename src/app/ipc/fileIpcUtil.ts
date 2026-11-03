import { dialog } from "electron";
import type { BrowserWindow } from "electron";

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

import type {
  FileContent,
  CadFile,
  CadFilePath,
} from "src/shared/types/File.type";

class FileIpcUtil {
  private static instance: FileIpcUtil;

  private openFilePathList: CadFilePath[] = [];
  private fileId = "";

  private isDialogOpen = false;
  private isMessageBoxShown = false;

  private constructor() {}

  public static getInstance(): FileIpcUtil {
    if (!FileIpcUtil.instance) {
      FileIpcUtil.instance = new FileIpcUtil();
    }
    return FileIpcUtil.instance;
  }

  private getFileContent(filePathList: CadFilePath[]) {
    const results: CadFile[] = [];

    for (const filePath of filePathList) {
      try {
        if (filePath.path) {
          const rawContent = fs.readFileSync(filePath.path, "utf-8");
          results.push({
            ...filePath,
            mtime: fs.statSync(filePath.path).mtime,
            fileContent: JSON.parse(rawContent),
          });
        } else {
          results.push({
            ...filePath,
            mtime: null,
            fileContent: null,
          });
        }
      } catch {
        // 읽지 못한 파일(이름 변경·이동·잠김)도 목록에 남긴다. 빼면 renderer 가 목록에 없는 탭으로 보고
        // 그 탭의 메모리 데이터(미저장 편집 포함)를 지운다. fileContent 가 null 이면 renderer 는 기존 데이터를 둔다.
        results.push({
          ...filePath,
          mtime: null,
          fileContent: null,
        });
      }
    }

    return results;
  }

  public getOpenFileList() {
    if (!this.openFilePathList.length) {
      this.createOpenFilePath();
      this.setFileId(this.openFilePathList[0].fileId);
    }

    return this.getFileContent(this.openFilePathList);
  }

  private getOpenFilePathById(fileId: string) {
    return this.openFilePathList.find((filePath) => filePath.fileId === fileId);
  }

  public getFileId() {
    return this.fileId;
  }

  public setFileId(fileId: string) {
    this.fileId = fileId;
  }

  public createOpenFilePath() {
    const count = this.openFilePathList.filter((item) => !item.path).length;
    const fileId = randomUUID();
    const fileName = count === 0 ? "UnTitled" : `UnTitled(${count})`;

    // fileId, openFilePathList 업데이트
    this.fileId = fileId;
    this.openFilePathList.push({
      fileId,
      fileName,
      path: null,
    });
  }

  public async saveFile(fileId: string, fileContent: FileContent) {
    try {
      const openFilePath = this.getOpenFilePathById(fileId);
      if (!openFilePath) throw new Error("filePath not found");

      // 기존 파일
      if (openFilePath.path) {
        // 파일 저장
        await fs.promises.writeFile(
          openFilePath.path,
          JSON.stringify(fileContent),
          "utf-8",
        );

        return true;
      }

      // 새 파일
      // 파일 저장 다이얼로그 표시
      if (this.isDialogOpen) throw new Error("dialog open");
      this.isDialogOpen = true;
      const result = await dialog.showSaveDialog({
        title: "Save CAD Editor File",
        filters: [{ name: "CAD Editor File", extensions: ["cad"] }],
      });
      this.isDialogOpen = false;

      if (result.canceled || !result.filePath) throw new Error("canceled");

      // 파일 저장
      await fs.promises.writeFile(
        result.filePath,
        JSON.stringify(fileContent),
        "utf-8",
      );

      const newFilePath: CadFilePath = {
        fileId,
        fileName: path.parse(result.filePath).name,
        path: result.filePath,
      };

      // openFilePathList 업데이트
      this.openFilePathList = this.openFilePathList.map((filePath) =>
        filePath.fileId === fileId ? newFilePath : filePath,
      );

      return true;
    } catch {
      return false;
    }
  }

  public async saveAsFile(fileId: string, fileContent: FileContent) {
    try {
      // 기존 파일과 별개로 새로 저장
      if (this.isDialogOpen) throw new Error("dialog open");
      this.isDialogOpen = true;
      const result = await dialog.showSaveDialog({
        title: "Save CAD Editor File As",
        filters: [{ name: "CAD Editor File", extensions: ["cad"] }],
      });
      this.isDialogOpen = false;

      if (result.canceled || !result.filePath) throw new Error("canceled");

      // 파일 저장
      await fs.promises.writeFile(
        result.filePath,
        JSON.stringify(fileContent),
        "utf-8",
      );

      const newFilePath: CadFilePath = {
        fileId: randomUUID(),
        fileName: path.parse(result.filePath).name,
        path: result.filePath,
      };

      // fileId, openFilePathList 업데이트
      this.fileId = newFilePath.fileId;
      this.openFilePathList = this.openFilePathList.map((filePath) =>
        filePath.fileId === fileId ? newFilePath : filePath,
      );

      return true;
    } catch {
      return false;
    }
  }

  public async openFile(isCurrentFileModified = true, filePath?: string) {
    try {
      if (filePath) {
        // 지정된 경로가 있는 경우
        if (!fs.existsSync(filePath)) throw new Error("invalid");
      } else {
        // 지정된 경로가 없는 경우
        // 파일 열기 다이얼로그 표시
        if (this.isDialogOpen) throw new Error("dialog open");
        this.isDialogOpen = true;
        let result: Electron.OpenDialogReturnValue;
        try {
          result = await dialog.showOpenDialog({
            title: "Open CAD Editor File",
            filters: [{ name: "CAD Editor File", extensions: ["cad"] }],
            properties: ["openFile"],
          });
        } finally {
          // dialog 가 throw 해도 isDialogOpen 이 stuck 되지 않도록 finally 보장.
          // 이전엔 throw 시 true 인 채 → 다음 Open File 호출이 "dialog open" 으로 항상 차단되는 버그.
          this.isDialogOpen = false;
        }

        if (result.canceled || !result.filePaths.length) {
          throw new Error("canceled");
        }

        filePath = result.filePaths[0];
      }

      const rawContent = await fs.promises.readFile(filePath, "utf-8");
      const fileContent: FileContent = JSON.parse(rawContent);
      const fileId = fileContent.fileId;

      // 이미 열려있는 파일인 경우
      const openFilePath = this.getOpenFilePathById(fileId);
      if (openFilePath) {
        // fileId 업데이트
        this.fileId = fileId;

        return true;
      }

      // 새로 여는 파일인 경우;
      const newFilePath: CadFilePath = {
        fileId,
        fileName: path.parse(filePath).name,
        path: filePath,
      };

      // 기존 파일이 저장되지 않은 새 파일이고 modified 상태가 아닌 경우 기존 파일 대체
      const shouldReplace =
        this.getOpenFilePathById(this.fileId)?.path === null &&
        !isCurrentFileModified;
      const newOpenFilePathList = shouldReplace
        ? this.openFilePathList.map((filePath) =>
            filePath.fileId === this.fileId ? newFilePath : filePath,
          )
        : [...this.openFilePathList, newFilePath];

      // fileId, openFilePathList 업데이트
      this.fileId = fileId;
      this.openFilePathList = newOpenFilePathList;

      return true;
    } catch {
      return false;
    }
  }

  public async closeFile(
    window: BrowserWindow,
    fileId: string,
    fileContent: FileContent,
    isModified: boolean,
  ) {
    try {
      const targetIndex = this.openFilePathList.findIndex(
        (filePath) => filePath.fileId === fileId,
      );
      // 이미 목록에 없는 파일은 닫힌 것으로 본다. false 를 돌려주면 renderer 가 창 닫기를 멈춰,
      // 이런 파일 하나 때문에 창을 영영 닫지 못하게 된다.
      if (targetIndex === -1) return true;

      // 수정된 내용이 없는 경우 닫기
      if (!isModified) {
        // 기존 파일이면 저장하고 닫기
        const openFilePath = this.openFilePathList[targetIndex];
        if (openFilePath.path) {
          const res: boolean = await this.saveFile(fileId, fileContent);
          if (!res) throw new Error("save failed");
        }

        this.openFilePathList.splice(targetIndex, 1);

        if (this.openFilePathList.length) {
          if (fileId === this.fileId) {
            this.fileId =
              this.openFilePathList[
                targetIndex === this.openFilePathList.length
                  ? targetIndex - 1
                  : targetIndex
              ].fileId;
          }
        } else {
          this.createOpenFilePath();
          this.setFileId(this.openFilePathList[0].fileId);
        }

        return true;
      }

      if (this.isMessageBoxShown) throw new Error("message box shown");
      this.isMessageBoxShown = true;
      let messageBox: Electron.MessageBoxReturnValue;
      try {
        const fileName = this.openFilePathList[targetIndex].fileName;
        messageBox = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["Save", "Don't Save", "Cancel"],
          defaultId: 0,
          cancelId: 2,
          title: "CAD Editor",
          noLink: true,
          message: `Changes detected in \n"${fileName}"\n Save before you continue?`,
          detail: `Your changes will be lost if you don't save them.`,
        });
      } finally {
        // 확인창을 띄우다 예외가 나도 풀어 둔다. 남아 있으면 이후의 닫기가 모두 false 가 돼 창을 닫을 수 없다.
        this.isMessageBoxShown = false;
      }

      // Cancel
      if (messageBox.response === 2) throw new Error("canceled");

      // Save
      if (messageBox.response === 0) {
        const res: boolean = await this.saveFile(fileId, fileContent);
        if (!res) throw new Error("save failed");
      }

      this.openFilePathList.splice(targetIndex, 1);

      if (this.openFilePathList.length) {
        if (fileId === this.fileId) {
          this.fileId =
            this.openFilePathList[
              targetIndex === this.openFilePathList.length
                ? targetIndex - 1
                : targetIndex
            ].fileId;
        }
      } else {
        this.createOpenFilePath();
        this.setFileId(this.openFilePathList[0].fileId);
      }

      return true;
    } catch {
      return false;
    }
  }
}

const fileIpcUtil = FileIpcUtil.getInstance();

export default fileIpcUtil;
