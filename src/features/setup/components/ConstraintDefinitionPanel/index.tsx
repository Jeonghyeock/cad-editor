// Constraint Definition 다이얼로그 (CATIA Constraints Definition 정합)
// 14 개 geometric constraint type 을 2열 grid 에 체크박스 + label 로 표시.
// applicable 한 type 만 enable, applied 면 checked. 클릭 시 즉시 toggle (적용 또는 제거).

import { useAtomValue } from "jotai";
import React, { memo } from "react";

import CheckBox from "src/components/CheckBox";

import {
  setupConstraintApplicabilityAtom,
  setupAppliedConstraintTypesAtom,
} from "../../Setup.store";
import type { SketchConstraint } from "../../sketch/constraints/SketchConstraint.type";

import FloatingPanel from "../FloatingPanel";

type ConstraintEntry = {
  type: SketchConstraint["type"];
  label: string;
};

// CATIA Constraints Definition 다이얼로그 순서 (1요소 → 2요소 → 3요소 → CAD Editor 전용).
const CONSTRAINT_ENTRIES: ConstraintEntry[] = [
  { type: "fix", label: "Fix" },
  { type: "horizontal", label: "Horizontal" },
  { type: "vertical", label: "Vertical" },
  { type: "coincident", label: "Coincidence" },
  { type: "concentric", label: "Concentricity" },
  { type: "tangent", label: "Tangency" },
  { type: "parallel", label: "Parallelism" },
  { type: "midpoint", label: "MidPoint" },
  { type: "perpendicular", label: "Perpendicularity" },
  { type: "symmetric", label: "Symmetry" },
  { type: "colinear", label: "Colinear" },
  { type: "equal", label: "Equal" },
  { type: "point_on_circle", label: "Point on Circle" },
  { type: "equal_radius", label: "Equal Radius" },
  { type: "equidistant", label: "Equidistant" },
  { type: "fix_together", label: "Fix Together" },
];

type ConstraintDefinitionPanelProps = {
  onApplyConstraint: (type: SketchConstraint["type"]) => void;
  onClose: () => void;
};

const ConstraintDefinitionPanel = memo(({
  onApplyConstraint,
  onClose,
}: ConstraintDefinitionPanelProps) => {
  const applicability = useAtomValue(setupConstraintApplicabilityAtom);
  const applied = useAtomValue(setupAppliedConstraintTypesAtom);

  return (
    <FloatingPanel
      title="Constraints Definition"
      onClose={onClose}
      width={320}
      className="input__dimension-panel input__constraint-dialog"
    >
      <div className="input__constraint-dialog__grid">
        {CONSTRAINT_ENTRIES.map((entry) => {
          const isApplicable = applicability[entry.type];
          const isApplied = applied.has(entry.type);
          const inputId = `constraint-def-${entry.type}`;
          return (
            <div
              key={entry.type}
              className={`input__constraint-dialog__row${isApplicable ? "" : " disabled"}`}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <CheckBox
                id={inputId}
                checked={isApplied}
                disabled={!isApplicable}
                onChange={() => {
                  if (!isApplicable) return;
                  onApplyConstraint(entry.type);
                }}
              />
              <label htmlFor={inputId} className="input__constraint-dialog__label">
                {entry.label}
              </label>
            </div>
          );
        })}
      </div>
    </FloatingPanel>
  );
});

ConstraintDefinitionPanel.displayName = "ConstraintDefinitionPanel";

export default ConstraintDefinitionPanel;
