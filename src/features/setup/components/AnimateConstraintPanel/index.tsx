// 구속조건 애니메이션 다이얼로그 (CATIA V5 스타일)
// min~max 사이 값을 단계적으로 변경하며 스케치 변형 애니메이션

import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import FloatingPanel from "../FloatingPanel";

type AnimateConstraintPanelProps = {
  constraintId: string;
  currentValue: number;
  onValueChange: (constraintId: string, value: number) => void;
  onClose: () => void;
};

const AnimateConstraintPanel = memo(({
  constraintId,
  currentValue,
  onValueChange,
  onClose,
}: AnimateConstraintPanelProps) => {
  const [minValue, setMinValue] = useState((currentValue * 0.5).toFixed(2));
  const [maxValue, setMaxValue] = useState((currentValue * 1.5).toFixed(2));
  const [steps, setSteps] = useState(20);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  const animFrameRef = useRef(0);
  const playingRef = useRef(false);
  const loopRef = useRef(false);
  const originalValueRef = useRef(currentValue);

  // ref를 동기화 (클로저 stale 방지)
  useEffect(() => { playingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { loopRef.current = loop; }, [loop]);

  // 애니메이션 루프
  const animate = useCallback(() => {
    const min = parseFloat(minValue);
    const max = parseFloat(maxValue);
    if (isNaN(min) || isNaN(max) || min >= max || steps < 2) return;

    let step = 0;
    const interval = 1000 / 30; // ~30fps
    let lastTime = 0;

    const tick = (time: number) => {
      if (!playingRef.current) return;

      if (time - lastTime < interval) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastTime = time;

      const t = step / (steps - 1);
      const value = min + t * (max - min);
      onValueChange(constraintId, value);
      setCurrentStep(step);

      step++;
      if (step >= steps) {
        if (loopRef.current) {
          step = 0;
        } else {
          setIsPlaying(false);
          playingRef.current = false;
          return;
        }
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
  }, [constraintId, minValue, maxValue, steps, onValueChange]);

  // 재생/일시정지
  const handleTogglePlay = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
      cancelAnimationFrame(animFrameRef.current);
    } else {
      setIsPlaying(true);
      animate();
    }
  }, [isPlaying, animate]);

  // 닫기 시 원래 값 복원
  const handleClose = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    setIsPlaying(false);
    onValueChange(constraintId, originalValueRef.current);
    onClose();
  }, [constraintId, onValueChange, onClose]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  return (
    <FloatingPanel
      title="Animate Constraint"
      onClose={handleClose}
      width={260}
      className="input__dimension-panel"
      footer={
        <>
          <button
            type="button"
            className="input__floating-panel__btn input__floating-panel__btn--secondary"
            onClick={handleClose}
          >
            Close
          </button>
          <button
            type="button"
            className="input__floating-panel__btn"
            onClick={handleTogglePlay}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
        </>
      }
    >
      <div className="input__dimension-panel__body" style={{ padding: 0, gap: 12 }}>
        {/* Min/Max 값 */}
        <div className="input__dimension-panel__field">
          <label className="input__dimension-panel__label">Min</label>
          <input
            type="number"
            className="input__dimension-panel__input"
            value={minValue}
            onChange={(e) => setMinValue(e.target.value)}
            disabled={isPlaying}
          />
        </div>
        <div className="input__dimension-panel__field">
          <label className="input__dimension-panel__label">Max</label>
          <input
            type="number"
            className="input__dimension-panel__input"
            value={maxValue}
            onChange={(e) => setMaxValue(e.target.value)}
            disabled={isPlaying}
          />
        </div>

        {/* 스텝 슬라이더 */}
        <div className="input__dimension-panel__field">
          <label className="input__dimension-panel__label">Steps: {steps}</label>
          <input
            type="range"
            min={5}
            max={100}
            value={steps}
            onChange={(e) => setSteps(parseInt(e.target.value, 10))}
            disabled={isPlaying}
            style={{ width: "100%" }}
          />
        </div>

        {/* 진행 표시 */}
        <div className="input__dimension-panel__field">
          <label className="input__dimension-panel__label">
            Step: {currentStep + 1} / {steps}
          </label>
        </div>

        {/* Loop 체크박스 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            id="animate-loop"
            checked={loop}
            onChange={(e) => setLoop(e.target.checked)}
          />
          <label htmlFor="animate-loop" style={{ fontSize: 11, color: "#6b7280" }}>
            Loop
          </label>
        </div>
      </div>
    </FloatingPanel>
  );
});

AnimateConstraintPanel.displayName = "AnimateConstraintPanel";

export default AnimateConstraintPanel;
