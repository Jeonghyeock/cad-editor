// Active length unit holder — class-based renderer (ConstraintRenderer 등) 가 React atom
// 직접 구독 어려워서 module-level holder + listener. React side (setup feature root) 가
// `unitAtom` 구독 + `setActiveLengthUnit` 호출 + scene markFullRedraw 로 sync 트리거.
//
// 사용자 가시 dimension label / coordinate / sketch overlay 표시에만 영향 — 저장값은 mm.

import {
  CONFIG_UNIT_LENGTH_FUNCTION,
  CONFIG_UNIT_LENGTH_LABEL,
} from "src/shared/constants/Config.constant";
import type { CONFIG_UNIT } from "src/shared/constants/Config.constant";

type Unit = keyof typeof CONFIG_UNIT;

let _unit: Unit = "MMGS";

export const getActiveLengthUnit = (): Unit => _unit;

export const setActiveLengthUnit = (u: Unit): boolean => {
  if (_unit === u) return false;
  _unit = u;
  return true;
};

/** mm → display unit. precision 2 자리 (sketch label 의 시각 안정성). */
export const formatLengthDisplay = (mm: number, fractionDigits = 2): string =>
  CONFIG_UNIT_LENGTH_FUNCTION[_unit](mm).toFixed(fractionDigits);

/** "mm" / "cm" / "m" / "in". */
export const activeLengthLabel = (): string => CONFIG_UNIT_LENGTH_LABEL[_unit];
