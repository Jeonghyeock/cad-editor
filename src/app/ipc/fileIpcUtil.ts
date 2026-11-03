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

/**
 * 두 경로가 같은 파일을 가리키는지 본다.
 * 둘 다 있으면 실제 경로(realpath)로 비교해 심볼릭 링크·정션, macOS 의 대소문자 무시 볼륨, Windows 8.3 짧은
 * 이름도 같은 파일로 본다. 하나라도 없으면(이름이 바뀐 열린 파일 등) 절대 경로 문자열로 비교하고, Windows 는
 * 대소문자를 가리지 않는다.
 */
export const isSameFilePath = (
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    // 없는 경로 — 아래 문자열 비교로
  }

  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const normalize = (filePath: string) => {
    const resolved = pathModule.resolve(filePath);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
};

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

      // 파일 저장. 새 파일에는 새 fileId 를 기록한다 — 옛 fileId 를 그대로 쓰면 탭의 fileId 와 어긋나,
      // 다시 열 때 같은 경로를 다른 파일로 보거나 원본과 fileId 가 겹친다.
      const newFileId = randomUUID();
      await fs.promises.writeFile(
        result.filePath,
        JSON.stringify({ ...fileContent, fileId: newFileId }),
        "utf-8",
      );

      const newFilePath: CadFilePath = {
        fileId: newFileId,
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

      // 이미 열려있는 파일인 경우. 파일 안의 fileId 가 아니라 경로로 판정한다 — fileId 로 보면 탐색기 복사본이나
      // fileId 가 없는 파일을 이미 열린 다른 파일로 오인해, 새 탭 없이 그 탭으로 바꾸기만 했다.
      // 읽기 전에 판정해, 쓰는 중이라 깨진 파일도 그 탭으로 바꾸고 큰 파일을 헛읽지 않는다.
      const openFilePath = this.openFilePathList.find(
        (item) => item.path && isSameFilePath(item.path, filePath),
      );
      if (openFilePath) {
        // fileId 업데이트
        this.fileId = openFilePath.fileId;

        return true;
      }

      const rawContent = await fs.promises.readFile(filePath, "utf-8");
      const fileContent: FileContent = JSON.parse(rawContent);

      // 같은 fileId 로 두 탭이 열리면 renderer 가 fileId 별로 둔 데이터가 섞인다. 파일 안의 fileId 가 없거나
      // 이미 열린 다른 파일과 겹치면(복사본, 이전 버전에서 Save As 한 파일) 새로 발급한다.
      const fileId =
        typeof fileContent.fileId === "string" &&
        fileContent.fileId &&
        !this.getOpenFilePathById(fileContent.fileId)
          ? fileContent.fileId
          : randomUUID();

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

      // 수정된 내용이 없는 경우 디스크에 쓰지 않고 닫기.
      // 다시 쓰면 읽기 전용 파일은 쓰기 실패로 탭이 닫히지 않고, 열어 둔 사이 바깥(git·동기화)에서 바뀐 파일은
      // 연 시점의 내용으로 덮어써진다. 그 대신 수정 감지에 들지 않는 lastURL 등은 저장되지 않는다.
      if (!isModified) {
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
