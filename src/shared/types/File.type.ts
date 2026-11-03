import type { SetupData, SetupPersistentData } from "src/features/setup/Setup.type";

import type { CONFIG_UNIT } from "../constants/Config.constant";

export type CadFilePath = {
  fileId: string;
  fileName: string;
  path: string;
};

export type CadFile = {
  fileId: string;
  fileName: string;
  path: string;
  /** 아직 저장하지 않은 새 파일이거나 디스크에서 읽지 못한 파일(이름 변경·이동·잠김)이면 null. */
  mtime: Date | null;
  /** mtime 과 같은 경우 null — renderer 는 이때 메모리의 기존 데이터를 그대로 둔다. */
  fileContent: FileContent | null;
};

export type FileData = {
  fileId: string;
  globalData: GlobalData;
  originData: GlobalData;
};

/**
 * 파일 영속 + 메모리 전용 데이터의 통합 상태 (순수 CAD 에디터 — setup 단일 storage).
 */
export type GlobalData = {
  /** 파일별 단위계 (MMGS / MKS / CGS / IPS). */
  unit: keyof typeof CONFIG_UNIT;
  /** 에디터 작업 상태 (sketch / operation / model / view / undo 등). */
  setup: SetupData;
  lastURL: string | null;
};

export type PersistentData = {
  unit: GlobalData["unit"];
  setup: SetupPersistentData;
  lastURL: GlobalData["lastURL"];
};

export type FileContent = PersistentData & {
  fileId: string;
  preview: string | null;
};

export type DiffData = {
  unit: GlobalData["unit"];
  setup: SetupPersistentData;
};
