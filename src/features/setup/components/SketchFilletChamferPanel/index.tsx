// 스케치 Fillet/Chamfer 값 입력 패널 (DimensionPanel과 동일 패턴).
// length 값 (radius / distance) 은 globalData.unit 따라 display/input 환산. chamfer 의
// distance-angle / angle-hypotenuse 모드에서 value2 가 angle 인 경우는 piMode 분기로 처리.

import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import { useLengthUnit } from "src/shared/hooks/useLengthUnit";

import type { ChamferParamInputMode, ChamferParamMode } from "../../Setup.store";

import FloatingPanel from "../FloatingPanel";

type PanelType = "fillet" | "chamfer" | "offset";

type SketchFilletChamferPanelProps = {
  type: PanelType;
  defaultValue: number;
  defaultValue2?: number;
  chamferParamMode?: ChamferParamMode;
  chamferParamInputMode?: ChamferParamInputMode;
  onChamferParamInputModeChange?: (mode: ChamferParamInputMode) => void;
  onConfirm: (value: number, value2?: number) => void;
  onCancel: () => void;
  onValueChange?: (value: number, value2?: number) => void;
};

const TYPE_LABELS: Record<PanelType, string> = {
  fillet: "Fillet Radius",
  chamfer: "Chamfer Distance",
  offset: "Offset Distance",
};

const SketchFilletChamferPanel = memo(({ type, defaultValue, defaultValue2, chamferParamMode: initialParamMode, chamferParamInputMode, onChamferParamInputModeChange, onConfirm, onCancel, onValueChange }: SketchFilletChamferPanelProps) => {
  const lu = useLengthUnit();
  const [value, setValue] = useState(lu.toDisplay(defaultValue).toFixed(2));
  const [value2, setValue2] = useState(lu.toDisplay(defaultValue2 ?? defaultValue).toFixed(2));
  const [paramMode, setParamMode] = useState<ChamferParamMode>(initialParamMode ?? "symmetric");
  const [piMode, setPiMode] = useState<ChamferParamInputMode>(chamferParamInputMode ?? "two-distances");
  const inputRef = useRef<HTMLInputElement>(null);

  // 파라미터 입력 모드에 따라 2개 입력 필드 표시 여부 결정
  const needsTwoInputs = type === "chamfer" && (
    paramMode === "two-distances" || piMode === "distance-angle" || piMode === "angle-hypotenuse"
  );
  const isChamferTwoDistances = type === "chamfer" && paramMode === "two-distances";
  // value2 가 angle 인 경우 (distance-angle / angle-hypotenuse) — length 환산 X.
  const value2IsAngle = type === "chamfer" && (piMode === "distance-angle" || piMode === "angle-hypotenuse") && paramMode !== "two-distances";

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // 값 변경 시 프리뷰 업데이트 — display unit → mm 역환산해 caller 에 전달.
  useEffect(() => {
    const parsed = parseFloat(value);
    const parsed2 = parseFloat(value2);
    const v1Mm = !isNaN(parsed) && parsed > 0 ? lu.fromDisplay(parsed) : 0;
    const v2Raw = !isNaN(parsed2) && parsed2 > 0 ? parsed2 : 0;
    const v2 = value2IsAngle ? v2Raw : lu.fromDisplay(v2Raw);
    onValueChange?.(v1Mm, needsTwoInputs ? v2 : undefined);
  }, [value, value2, needsTwoInputs, value2IsAngle, lu, onValueChange]);

  const handleConfirm = useCallback(() => {
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed <= 0) return;
    const v1Mm = lu.fromDisplay(parsed);

    if (needsTwoInputs) {
      const parsed2 = parseFloat(value2);
      if (isNaN(parsed2) || parsed2 <= 0) return;
      const v2 = value2IsAngle ? parsed2 : lu.fromDisplay(parsed2);
      onConfirm(v1Mm, v2);
    } else {
      onConfirm(v1Mm);
    }
  }, [value, value2, needsTwoInputs, value2IsAngle, lu, onConfirm]);

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
      title={`${TYPE_LABELS[type]} (${lu.label})`}
      onClose={onCancel}
      className="input__dimension-panel"
      footer={
        <>
          <button type="button" className="input__floating-panel__btn input__floating-panel__btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="input__floating-panel__btn" onClick={handleConfirm}>
            OK
          </button>
        </>
      }
    >
        {/* Chamfer 모드 토글 */}
        {type === "chamfer" && (
          <>
            <div className="input__dimension-panel__mode-toggle">
              <button
                type="button"
                className={`input__dimension-panel__mode-btn ${paramMode === "symmetric" ? "input__dimension-panel__mode-btn--active" : ""}`}
                onClick={() => setParamMode("symmetric")}
                title="Symmetric distance"
              >
                D
              </button>
              <button
                type="button"
                className={`input__dimension-panel__mode-btn ${paramMode === "two-distances" ? "input__dimension-panel__mode-btn--active" : ""}`}
                onClick={() => setParamMode("two-distances")}
                title="Two distances"
              >
                D1/D2
              </button>
            </div>
            {/* Chamfer 파라미터 입력 모드 (Gap 7) */}
            <div className="input__dimension-panel__mode-toggle">
              <button
                type="button"
                className={`input__dimension-panel__mode-btn ${piMode === "two-distances" ? "input__dimension-panel__mode-btn--active" : ""}`}
                onClick={() => { setPiMode("two-distances"); onChamferParamInputModeChange?.("two-distances"); }}
                title="Two distances (D1, D2)"
              >
                D×D
              </button>
              <button
                type="button"
                className={`input__dimension-panel__mode-btn ${piMode === "distance-angle" ? "input__dimension-panel__mode-btn--active" : ""}`}
                onClick={() => { setPiMode("distance-angle"); onChamferParamInputModeChange?.("distance-angle"); }}
                title="Distance + Angle (D, θ)"
              >
                D+A
              </button>
              <button
                type="button"
                className={`input__dimension-panel__mode-btn ${piMode === "angle-hypotenuse" ? "input__dimension-panel__mode-btn--active" : ""}`}
                onClick={() => { setPiMode("angle-hypotenuse"); onChamferParamInputModeChange?.("angle-hypotenuse"); }}
                title="Angle + Hypotenuse (θ, H)"
              >
                A+H
              </button>
            </div>
          </>
        )}

        <div className="input__dimension-panel__field">
          <label className="input__dimension-panel__label">
            {type === "fillet" ? "Radius"
              : type === "offset" ? "Distance"
              : piMode === "angle-hypotenuse" ? "Angle (°)"
              : isChamferTwoDistances || piMode !== "two-distances" ? "Distance 1" : "Distance"}
          </label>
          <input
            ref={inputRef}
            type="number"
            className="input__dimension-panel__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            min={0.01}
            step={piMode === "angle-hypotenuse" || piMode === "distance-angle" ? 1 : 0.1}
          />
        </div>

        {needsTwoInputs && (
          <div className="input__dimension-panel__field">
            <label className="input__dimension-panel__label">
              {piMode === "distance-angle" ? "Angle (°)"
                : piMode === "angle-hypotenuse" ? "Hypotenuse"
                : "Distance 2"}
            </label>
            <input
              type="number"
              className="input__dimension-panel__input"
              value={value2}
              onChange={(e) => setValue2(e.target.value)}
              onKeyDown={handleKeyDown}
              min={0.01}
              step={piMode === "distance-angle" ? 1 : 0.1}
            />
          </div>
        )}
    </FloatingPanel>
  );
});

SketchFilletChamferPanel.displayName = "SketchFilletChamferPanel";

export default SketchFilletChamferPanel;
