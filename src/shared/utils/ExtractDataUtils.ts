import { extractSetupPersistentData } from "src/features/setup/utils/serialization";

import type { DiffData, GlobalData, PersistentData } from "../types/File.type";

export const extractPersistentData = (data: GlobalData): PersistentData => ({
  unit: data.unit,
  lastURL: data.lastURL,
  // SetupData → SetupPersistentData (cameraState 등 메모리 전용 필드 제거).
  setup: extractSetupPersistentData(data.setup),
});

export const extractComparableData = (data: GlobalData): DiffData => ({
  // 수정 감지에서 cameraState 같은 메모리 필드 제외.
  unit: data.unit,
  setup: extractSetupPersistentData(data.setup),
});
