// 다중 구속조건 편집 다이얼로그 (CATIA V5 스타일)
// 모든 dimension 구속을 스크롤 리스트로 표시하고 일괄 편집 가능

import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import { useLengthUnit } from "src/shared/hooks/useLengthUnit";

import type { SketchConstraint } from "../../sketch/constraints/SketchConstraint.type";

import FloatingPanel from "../FloatingPanel";

// dimension 값을 가진 구속 타입
const DIMENSION_TYPES = new Set([
  "distance", "line_length", "angle", "line_angle", "radius", "diameter",
  "point_line_distance", "horizontal_distance", "vertical_distance",
]);

// angle 타입 — unit 환산 X. 그 외 모두 length.
const ANGLE_TYPES = new Set(["angle", "line_angle"]);

// 구속 타입 라벨
const TYPE_LABELS: Record<string, string> = {
  distance: "Distance",
  line_length: "Length",
  angle: "Angle",
  line_angle: "Line Angle",
  radius: "Radius",
  diameter: "Diameter",
  point_line_distance: "Pt-Line Dist",
  horizontal_distance: "H-Distance",
  vertical_distance: "V-Distance",
};

type EditMultiConstraintPanelProps = {
  constraints: Map<string, SketchConstraint>;
  onApply: (changes: Map<string, number>) => void;
  onClose: () => void;
};

const EditMultiConstraintPanel = memo(({
  constraints,
  onApply,
  onClose,
}: EditMultiConstraintPanelProps) => {
  const lu = useLengthUnit();
  // dimension 구속만 필터
  const dimensionConstraints = useRef<{ id: string; type: string; originalValue: number }[]>([]);

  // 값 상태 (id → string 입력값)
  const [values, setValues] = useState<Map<string, string>>(new Map());

  // 초기화: dimension 구속 목록 및 값 추출. length 타입은 display unit 환산.
  useEffect(() => {
    const dims: { id: string; type: string; originalValue: number }[] = [];
    const initValues = new Map<string, string>();

    for (const [, c] of constraints) {
      if (!DIMENSION_TYPES.has(c.type)) continue;
      if ("value" in c && typeof c.value === "number") {
        dims.push({ id: c.id, type: c.type, originalValue: c.value });
        const display = ANGLE_TYPES.has(c.type) ? c.value : lu.toDisplay(c.value);
        initValues.set(c.id, display.toFixed(2));
      }
    }

    dimensionConstraints.current = dims;
    setValues(initValues);
  }, [constraints, lu]);

  const handleValueChange = useCallback((id: string, val: string) => {
    setValues((prev) => {
      const next = new Map(prev);
      next.set(id, val);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    const changes = new Map<string, number>();
    for (const dim of dimensionConstraints.current) {
      const strVal = values.get(dim.id);
      if (!strVal) continue;
      const parsed = parseFloat(strVal);
      if (isNaN(parsed)) continue;
      // length type 은 display unit → mm 역환산.
      const committed = ANGLE_TYPES.has(dim.type) ? parsed : lu.fromDisplay(parsed);
      // 값이 변경된 경우만 포함
      if (Math.abs(committed - dim.originalValue) > 1e-9) {
        changes.set(dim.id, committed);
      }
    }
    if (changes.size > 0) {
      onApply(changes);
    }
    onClose();
  }, [values, lu, onApply, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleApply();
      }
    },
    [handleApply, onClose],
  );

  return (
    <FloatingPanel
      title="Edit Constraints"
      onClose={onClose}
      width={280}
      className="input__dimension-panel"
      footer={
        <>
          <button
            type="button"
            className="input__floating-panel__btn input__floating-panel__btn--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="input__floating-panel__btn"
            onClick={handleApply}
          >
            OK
          </button>
        </>
      }
    >
      <div onKeyDown={handleKeyDown}>
        {dimensionConstraints.current.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9199a1", textAlign: "center", padding: 12 }}>
            No dimension constraints
          </div>
        ) : (
          dimensionConstraints.current.map((dim) => (
            <div key={dim.id} className="input__dimension-panel__field">
              <label className="input__dimension-panel__label">
                {TYPE_LABELS[dim.type] ?? dim.type}
              </label>
              <input
                type="number"
                className="input__dimension-panel__input"
                value={values.get(dim.id) ?? ""}
                onChange={(e) => handleValueChange(dim.id, e.target.value)}
                onKeyDown={handleKeyDown}
                step={0.1}
              />
            </div>
          ))
        )}
      </div>
    </FloatingPanel>
  );
});

EditMultiConstraintPanel.displayName = "EditMultiConstraintPanel";

export default EditMultiConstraintPanel;
