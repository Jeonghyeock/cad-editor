// Length unit conversion hook — globalData.unit 따라 mm ↔ display unit 변환 + label 제공.
// 저장값은 항상 mm (sketch coordinate / engine joint x,y / feature param dimension base).
// 사용자 표시/입력만 환산.

import { useAtomValue } from "jotai";
import { useMemo } from "react";

import {
  CONFIG_UNIT_LENGTH_FUNCTION,
  CONFIG_UNIT_LENGTH_LABEL,
  CONFIG_UNIT_LENGTH_REVERSE_FUNCTION,
} from "src/shared/constants/Config.constant";
import { unitAtom } from "src/shared/stores/Config.store";

export const useLengthUnit = () => {
  const unit = useAtomValue(unitAtom);
  return useMemo(
    () => ({
      unit,
      /** 단위 label — "mm" / "cm" / "m" / "in". */
      label: CONFIG_UNIT_LENGTH_LABEL[unit],
      /** mm → 현재 단위 (precision 6 자리, 표시용). */
      toDisplay: (mm: number): number =>
        Number(CONFIG_UNIT_LENGTH_FUNCTION[unit](mm).toFixed(6)),
      /** 현재 단위 → mm (입력 → 저장). */
      fromDisplay: (v: number): number =>
        CONFIG_UNIT_LENGTH_REVERSE_FUNCTION[unit](v),
    }),
    [unit],
  );
};
