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

test("첫 표시는 정수부를 모두 남기고 소수만 유효 자리를 제한한다", () => {
  // 고치기 전(이 PR 의 앞 커밋)에는 toPrecision(6) 이 큰 값의 정수부를 반올림했다 (123456.789 → "123457")
  assert.equal(formatDimensionInput(123456.789), "123456.789");
  assert.equal(formatDimensionInput(1234567.25), "1234567.25");
  assert.equal(formatDimensionInput(37.45678912), "37.456789");
  assert.equal(formatDimensionInput(0.0123456789), "0.0123457");
  assert.equal(formatDimensionInput(40), "40.00");
  assert.equal(confirmUnchanged("MMGS", 123456.789), 123456.789);
});

test("입력 글자가 처음 표시한 글자와 같을 때만 원래 값을 쓰고, 다르게 친 값은 반영한다", () => {
  // 고치기 전(이 PR 의 앞 커밋)에는 숫자로 비교해, 표시값 "12.3457" 을 일부러 "12.34570" 으로 쳐도
  // 원래 값(12.3456999)을 썼고, "12.3457abc" 도 parseFloat 로 통과해 원래 값으로 확정됐다
  const mm = fromDisplay("MMGS");
  const initialText = formatDimensionInput(toDisplay("MMGS", 12.3456999));
  assert.equal(initialText, "12.3457");
  assert.equal(resolveDimensionInput(" 12.3457 ", initialText, 12.3456999, "distance", mm), 12.3456999);
  assert.equal(resolveDimensionInput("12.34570", initialText, 12.3456999, "distance", mm), 12.3457);
  assert.equal(resolveDimensionInput("12.3457abc", initialText, 12.3456999, "distance", mm), null);
  assert.equal(resolveDimensionInput("40abc", initialText, 12.3456999, "distance", mm), null);
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
