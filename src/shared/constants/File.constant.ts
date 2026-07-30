import { INITIAL_SETUP_DATA } from "src/features/setup/Setup.constant";

import type { PersistentData, GlobalData } from "src/shared/types/File.type";

import { CONFIG_UNIT } from "./Config.constant";

export const INITIAL_GLOBAL_DATA: GlobalData = Object.freeze({
  unit: CONFIG_UNIT.MMGS,
  setup: INITIAL_SETUP_DATA,
  lastURL: null,
});

export const INITIAL_FILE_DATA: PersistentData = Object.freeze({
  unit: INITIAL_GLOBAL_DATA.unit,
  setup: INITIAL_SETUP_DATA,
  lastURL: INITIAL_GLOBAL_DATA.lastURL,
});
