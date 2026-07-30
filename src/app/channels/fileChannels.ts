export enum FileChannels {
  GET_FILE_ID = "getFileId",
  SET_FILE_ID = "setFileId",
  GET_OPEN_FILE_LIST = "getOpenFileList",
  CREATE_FILE = "createFile",
  SAVE_FILE = "saveFile",
  SAVE_AS_FILE = "saveAsFile",
  OPEN_FILE = "openFile",
  CLOSE_FILE = "closeFile",
  /** 일반 binary buffer + filter + 추천 파일명 → save dialog + fs.writeFile (STL export 등). */
  SAVE_BINARY_WITH_DIALOG = "saveBinaryWithDialog",
}
