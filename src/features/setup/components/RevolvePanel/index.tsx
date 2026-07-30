// Revolve 생성 패널 (angle, axis, direction 설정 + 라이브 프리뷰)

import React, { memo, useCallback, useEffect, useMemo, useState } from "react";

import type SetupScene from "../../rendering/SetupScene";
import type { RevolveDirection, SerializedGeometry } from "../../Setup.type";

import FloatingPanel from "../FloatingPanel";

type RevolveAxisType = "x" | "y" | "custom";

type RevolvePanelProps = {
  sketchPlaneKey: string;
  profileIds: string[];
  getScene: () => SetupScene | null;
  getGeometries: () => Map<string, SerializedGeometry>;
  onConfirm: (params: {
    angle: number;
    angle2?: number;
    axisType: RevolveAxisType;
    axisOrigin?: { x: number; y: number };
    axisDirection?: { x: number; y: number };
    revolveDirection: RevolveDirection;
    clockwise: boolean;
  }) => void;
  onCancel: () => void;
};

const AXIS_OPTIONS: { value: RevolveAxisType; label: string }[] = [
  { value: "x", label: "H Axis" },
  { value: "y", label: "V Axis" },
  { value: "custom", label: "Sketch Line" },
];

const DIR_OPTIONS: { value: RevolveDirection; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "reverse", label: "Reverse" },
  { value: "symmetric", label: "Symmetric" },
  { value: "two-angles", label: "Two Angles" },
];

const RevolvePanel = memo(({
  sketchPlaneKey,
  profileIds,
  getScene,
  getGeometries,
  onConfirm,
  onCancel,
}: RevolvePanelProps) => {
  const [angle, setAngle] = useState(360);
  const [angle2, setAngle2] = useState(180);
  const [axisType, setAxisType] = useState<RevolveAxisType>("y");
  const [customLineId, setCustomLineId] = useState<string | null>(null);
  const [revolveDir, setRevolveDir] = useState<RevolveDirection>("normal");
  const [clockwise, setClockwise] = useState(false);

  // 스케치 내 line 목록 (custom axis 선택용)
  const lineOptions = useMemo(() => {
    const geoms = getGeometries();
    const lines: { id: string; label: string }[] = [];
    let idx = 0;
    for (const [id, g] of geoms) {
      if (g.type === "line" && !("isReference" in g && g.isReference)) {
        idx++;
        lines.push({ id, label: `Line.${idx}` });
      }
    }
    return lines;
  }, [getGeometries]);

  // custom axis의 origin/direction 계산
  const customAxis = useMemo(() => {
    if (axisType !== "custom" || !customLineId) return undefined;
    const g = getGeometries().get(customLineId);
    if (!g || g.type !== "line") return undefined;
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return undefined;
    return { origin: { x: g.x1, y: g.y1 }, direction: { x: dx / len, y: dy / len } };
  }, [axisType, customLineId, getGeometries]);

  // custom axis 미선택 시 y축으로 폴백
  const effAxis = useMemo(
    () => axisType === "custom" && customAxis ? "custom" : axisType === "custom" ? "y" : axisType,
    [axisType, customAxis],
  );

  // 프리뷰 업데이트
  useEffect(() => {
    const scene = getScene();
    if (!scene) return;

    scene.showRevolvePreview(
      sketchPlaneKey, profileIds, angle, effAxis, getGeometries(),
      revolveDir === "two-angles" ? angle2 : undefined,
      revolveDir, clockwise,
      effAxis === "custom" && customAxis ? customAxis.origin : undefined,
      effAxis === "custom" && customAxis ? customAxis.direction : undefined,
    );

    return () => { scene.clearExtrudePreview(); };
  }, [sketchPlaneKey, profileIds, angle, angle2, effAxis, customAxis, revolveDir, clockwise, getScene, getGeometries]);

  const handleConfirm = useCallback(() => {
    onConfirm({
      angle,
      angle2: revolveDir === "two-angles" ? angle2 : undefined,
      axisType: effAxis as RevolveAxisType,
      axisOrigin: effAxis === "custom" && customAxis ? customAxis.origin : undefined,
      axisDirection: effAxis === "custom" && customAxis ? customAxis.direction : undefined,
      revolveDirection: revolveDir,
      clockwise,
    });
  }, [angle, angle2, effAxis, customAxis, revolveDir, clockwise, onConfirm]);

  return (
    <FloatingPanel
      title="Revolve"
      onClose={onCancel}
      width={280}
      className="input__pad-pocket-panel"
      footer={
        <>
          <button type="button" className="input__floating-panel__btn input__floating-panel__btn--secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="input__floating-panel__btn" onClick={handleConfirm}>OK</button>
        </>
      }
    >
        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">
            {revolveDir === "two-angles" ? "Angle 1 (°)" : "Angle (°)"}
          </label>
          <input
            type="number"
            className="input__pad-pocket-panel__input"
            value={angle}
            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0 && v <= 360) setAngle(v); }}
            min={1} max={360} step={15}
          />
        </div>

        {revolveDir === "two-angles" && (
          <div className="input__pad-pocket-panel__field">
            <label className="input__pad-pocket-panel__label">Angle 2 (°)</label>
            <input
              type="number"
              className="input__pad-pocket-panel__input"
              value={angle2}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0 && v <= 360) setAngle2(v); }}
              min={1} max={360} step={15}
            />
          </div>
        )}

        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Axis</label>
          <div className="input__pad-pocket-panel__direction-group">
            {AXIS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="input__pad-pocket-panel__direction-btn"
                data-active={axisType === opt.value}
                onClick={() => setAxisType(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {axisType === "custom" && (
          <div className="input__pad-pocket-panel__field">
            <label className="input__pad-pocket-panel__label">Axis Line</label>
            <select
              className="input__pad-pocket-panel__input"
              value={customLineId ?? ""}
              onChange={(e) => setCustomLineId(e.target.value || null)}
            >
              <option value="">-- Select --</option>
              {lineOptions.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Direction</label>
          <div className="input__pad-pocket-panel__direction-group">
            {DIR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="input__pad-pocket-panel__direction-btn"
                data-active={revolveDir === opt.value}
                onClick={() => setRevolveDir(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">
            <input
              type="checkbox"
              checked={clockwise}
              onChange={(e) => setClockwise(e.target.checked)}
            />
            {" "}Clockwise
          </label>
        </div>
    </FloatingPanel>
  );
});

RevolvePanel.displayName = "RevolvePanel";

export default RevolvePanel;
