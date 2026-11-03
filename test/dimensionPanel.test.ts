import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDimensionInput, resolveDimensionInput } from "src/features/setup/components/DimensionPanel/dimensionInput";

import {
  CONFIG_UNIT_LENGTH_FUNCTION,
  CONFIG_UNIT_LENGTH_REVERSE_FUNCTION,
} from "src/shared/constants/Config.constant";

type Unit = keyof typeof CONFIG_UNIT_LENGTH_FUNCTION;

// DimensionPanel 이 useLengthUnit 으로 하는 환산과 같다 (toDisplay 는 6 자리로 반올림)
const toDisplay = (unit: Unit, mm: number) => Number(CONFIG_UNIT_LENGTH_FUNCTION[unit](mm).toFixed(6));
const fromDisplay = (unit: Unit) => (v: number) => CONFIG_UNIT_LENGTH_REVERSE_FUNCTION[unit](v);

// 패널을 열고 입력을 그대로 둔 채 OK 했을 때 저장되는 값
const confirmUnchanged = (unit: Unit, mm: number) => {
  const initialText = formatDimensionInput(toDisplay(unit, mm));
  return resolveDimensionInput(initialText, initialText, mm, "distance", fromDisplay(unit));
};

test("값을 바꾸지 않고 OK 하면 길이 치수가 원래 값 그대로다", () => {
  // 고치기 전에는 표시 단위 기준 소수 2자리로 잘린 입력을 다시 환산해, MKS 12.5mm → 10mm,
  // IPS 10mm → 9.906mm, MMGS 37.4567 → 37.46 으로 바뀌었다
  assert.equal(confirmUnchanged("MKS", 12.5), 12.5);
  assert.equal(confirmUnchanged("IPS", 10), 10);
  assert.equal(confirmUnchanged("MMGS", 37.4567), 37.4567);
  assert.equal(confirmUnchanged("CGS", 40), 40);
});

test("작은 값도 0 으로 표시하지 않아, 그대로 OK 할 수 있다", () => {
  // 고치기 전에는 MKS 4mm 가 "0.00" 으로 보여 OK 가 비활성이었다
  const text = formatDimensionInput(toDisplay("MKS", 4));
  assert.notEqual(parseFloat(text), 0);
  assert.equal(confirmUnchanged("MKS", 4), 4);
});

test("값을 바꾸지 않고 OK 하면 각도 치수가 원래 값 그대로다", () => {
  const initialText = formatDimensionInput(37.4567);
  assert.equal(resolveDimensionInput(initialText, initialText, 37.4567, "angle", (v) => v), 37.4567);
});

test("사용자가 고친 값은 표시 단위에서 환산해 반영한다", () => {
  const initialText = formatDimensionInput(toDisplay("MKS", 12.5));
  assert.equal(resolveDimensionInput("0.02", initialText, 12.5, "distance", fromDisplay("MKS")), 20);
  assert.equal(resolveDimensionInput("1", "0.393701", 10, "distance", fromDisplay("IPS")), 25.4);
  assert.equal(resolveDimensionInput("200", "30.00", 30, "angle", (v) => v), 200);
});

test("유효하지 않은 입력은 확정하지 않는다", () => {
  const mm = fromDisplay("MMGS");
  assert.equal(resolveDimensionInput("", "40.00", 40, "distance", mm), null);
  assert.equal(resolveDimensionInput("0", "40.00", 40, "distance", mm), null);
  assert.equal(resolveDimensionInput("-5", "40.00", 40, "line_length", mm), null);
  assert.equal(resolveDimensionInput("360", "30.00", 30, "angle", (v) => v), null);
  assert.equal(resolveDimensionInput("-30", "30.00", 30, "line_angle", (v) => v), -30);
});
