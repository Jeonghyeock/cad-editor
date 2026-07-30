// Dimension 구속 값 입력 패널 (distance, line_length, angle, radius)
// length 타입은 globalData.unit 따라 display/input 환산 (저장값은 mm). angle 은 그대로.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLengthUnit } from "src/shared/hooks/useLengthUnit";

import type { DimensionConstraintType } from "../../sketch/constraints/ConstraintValidator";

import FloatingPanel from "../FloatingPanel";

type DimensionPanelProps = {
  type: DimensionConstraintType;
  defaultValue: number;
  onConfirm: (value: number) => void;
  onCancel: () => void;
};

const TYPE_LABELS: Record<DimensionConstraintType, string> = {
  distance: "Distance",
  horizontal_distance: "Horizontal Distance",
  vertical_distance: "Vertical Distance",
  line_length: "Length",
  line_angle: "Line Angle (°)",
  angle: "Angle (°)",
  radius: "Radius",
  diameter: "Diameter",
  point_line_distance: "Pt–Line Dist",
  line_line_distance: "Line–Line Dist",
  point_circle_distance: "Pt–Circle Dist",
  line_circle_distance: "Line–Circle Dist",
  circle_circle_distance: "Circle–Circle Dist",
  arc_length: "Arc Length",
  ellipse_major_radius: "Semi-Major Axis (driven)",
  ellipse_minor_radius: "Semi-Minor Axis",
  curve_length: "Curve Length (driven)",
};

// 각도 타입 제외 — 모두 length (mm) 라 환산 대상.
const ANGLE_TYPES = new Set<DimensionConstraintType>(["angle", "line_angle"]);


const DimensionPanel = memo(({ type, defaultValue, onConfirm, onCancel }: DimensionPanelProps) => {
  const lu = useLengthUnit();
  const isLength = !ANGLE_TYPES.has(type);
  const initialDisplay = useMemo(
    () => (isLength ? lu.toDisplay(defaultValue) : defaultValue),
    [defaultValue, isLength, lu],
  );
  const [value, setValue] = useState(initialDisplay.toFixed(2));
  const [hasError, setHasError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 단위 label — title 에 표시. angle 은 °, length 는 mm/cm/m/in.
  const titleSuffix = isLength ? ` (${lu.label})` : "";

  // 마운트 시 autoFocus + 전체 선택
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // 값 변경 시 에러 상태 검증
  useEffect(() => {
    const parsed = parseFloat(value);
    const invalid = isNaN(parsed) || (type === "line_angle" ? false : parsed <= 0) || (type === "angle" && parsed >= 360);
    setHasError(invalid);
  }, [value, type]);

  const handleConfirm = useCallback(() => {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return;
    if (type !== "line_angle" && parsed <= 0) return;
    // angle: 0 < value < 360 — 사잇각 / 보각 / 반사각 / 보반사각 모두 허용
    if (type === "angle" && parsed >= 360) return;
    // length 타입은 display → mm 역환산 후 commit.
    const committed = isLength ? lu.fromDisplay(parsed) : parsed;
    onConfirm(committed);
  }, [value, type, onConfirm, isLength, lu]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handleConfirm, onCancel],
  );

  return (
    <FloatingPanel
      title={TYPE_LABELS[type] + titleSuffix}
      onClose={onCancel}
      className="input__dimension-panel"
      footer={
        <>
          <button type="button" className="input__floating-panel__btn input__floating-panel__btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="input__floating-panel__btn" onClick={handleConfirm} disabled={hasError}>
            OK
          </button>
        </>
      }
    >
      <div className="input__dimension-panel__field">
        <input
          ref={inputRef}
          type="number"
          className={`input__dimension-panel__input${hasError ? " input__dimension-panel__input--error" : ""}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          min={0.01}
          step={type === "angle" ? 1 : 0.1}
        />
      </div>
    </FloatingPanel>
  );
});

DimensionPanel.displayName = "DimensionPanel";

export default DimensionPanel;
