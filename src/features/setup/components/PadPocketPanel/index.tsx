// Pad/Pocket 생성 패널 (depth, direction, draft angle 설정 + 라이브 프리뷰).
// 매 keystroke 마다 showExtrudePreview sync 호출 (detectClosedShapes O(N²) + mesh rebuild)
// 가 main thread block → input 클릭 무응답 회귀. lodash debounce 100ms 로 trailing 호출만.

import { useAtom } from "jotai";
import { debounce } from "lodash";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";

import type SetupScene from "../../rendering/SetupScene";
import { setupPadPocketModeAtom } from "../../Setup.store";
import type { PadPocketDirection, SerializedGeometry } from "../../Setup.type";

import FloatingPanel from "../FloatingPanel";

type PadPocketPanelProps = {
  getScene: () => SetupScene | null;
  getGeometries: () => Map<string, SerializedGeometry>;
  onConfirm: (depth: number, direction: PadPocketDirection, depth2?: number, draftAngle?: number) => void;
  onCancel: () => void;
};

const DIRECTION_OPTIONS: { value: PadPocketDirection; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "reverse", label: "Reverse" },
  { value: "both", label: "Symmetric" },
  { value: "two-dimensions", label: "2-Dim" },
];

const PadPocketPanel = memo(({
  getScene,
  getGeometries,
  onConfirm,
  onCancel,
}: PadPocketPanelProps) => {
  const [mode] = useAtom(setupPadPocketModeAtom);
  const [depth, setDepth] = useState(mode?.depth ?? 20);
  const [depth2, setDepth2] = useState(mode?.depth ?? 20);
  const [direction, setDirection] = useState<PadPocketDirection>(mode?.direction ?? "normal");
  const [draftAngle, setDraftAngle] = useState(0);

  // 모드 변경 시 초기값 동기화
  useEffect(() => {
    if (mode) {
      setDepth(mode.depth);
      setDepth2(mode.depth);
      setDirection(mode.direction);
    }
  }, [mode]);

  // 프리뷰 빌드 — debounce 100ms (trailing). 빠른 keystroke 시 main thread block 회피 +
  // preview flicker (매 keystroke 마다 mesh dispose + rebuild) 도 동시 해소.
  // useMemo 로 debouncer 인스턴스 stable (cancel 가능 보장).
  const debouncedShowPreview = useMemo(
    () =>
      debounce(
        (
          scene: SetupScene,
          sketchPlaneKey: string,
          profileIds: string[],
          d: number,
          dir: PadPocketDirection,
          geoms: Map<string, SerializedGeometry>,
          d2: number | undefined,
          draft: number | undefined,
        ) => {
          scene.showExtrudePreview(sketchPlaneKey, profileIds, d, dir, geoms, d2, draft);
        },
        100,
      ),
    [],
  );

  useEffect(() => {
    if (!mode) return;
    const scene = getScene();
    if (!scene) return;
    debouncedShowPreview(
      scene,
      mode.sketchPlaneKey,
      mode.profileIds,
      depth,
      direction,
      getGeometries(),
      direction === "two-dimensions" ? depth2 : undefined,
      draftAngle > 0 ? draftAngle : undefined,
    );
  }, [mode, depth, depth2, direction, draftAngle, getScene, getGeometries, debouncedShowPreview]);

  // unmount 시 — pending debounce 취소 + preview clear.
  useEffect(() => {
    return () => {
      debouncedShowPreview.cancel();
      getScene()?.clearExtrudePreview();
    };
  }, [debouncedShowPreview, getScene]);

  const handleDepthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val > 0) setDepth(val);
  }, []);

  const handleDepth2Change = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val > 0) setDepth2(val);
  }, []);

  const handleDraftChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val >= 0 && val <= 45) setDraftAngle(val);
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(
      depth,
      direction,
      direction === "two-dimensions" ? depth2 : undefined,
      draftAngle > 0 ? draftAngle : undefined,
    );
  }, [depth, depth2, direction, draftAngle, onConfirm]);

  if (!mode) return null;

  const baseLabel = mode.type === "pad" ? "Pad" : "Pocket";
  const typeLabel = mode.editingOperationId ? `Edit ${baseLabel}` : baseLabel;

  return (
    <FloatingPanel
      title={typeLabel}
      onClose={onCancel}
      width={280}
      className="input__pad-pocket-panel"
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
      <div className="input__pad-pocket-panel__field">
        <label className="input__pad-pocket-panel__label">
          {direction === "two-dimensions" ? "Depth 1 (mm)" : "Depth (mm)"}
        </label>
        <input
          type="number"
          className="input__pad-pocket-panel__input"
          value={depth}
          onChange={handleDepthChange}
          min={0.1}
          step={1}
        />
      </div>

      {direction === "two-dimensions" && (
        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Depth 2 (mm)</label>
          <input
            type="number"
            className="input__pad-pocket-panel__input"
            value={depth2}
            onChange={handleDepth2Change}
            min={0.1}
            step={1}
          />
        </div>
      )}

      <div className="input__pad-pocket-panel__field">
        <label className="input__pad-pocket-panel__label">Direction</label>
        <div className="input__pad-pocket-panel__direction-group">
          {DIRECTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="input__pad-pocket-panel__direction-btn"
              data-active={direction === opt.value}
              onClick={() => setDirection(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="input__pad-pocket-panel__field">
        <label className="input__pad-pocket-panel__label">Draft Angle (°)</label>
        <input
          type="number"
          className="input__pad-pocket-panel__input"
          value={draftAngle}
          onChange={handleDraftChange}
          min={0}
          max={45}
          step={0.5}
        />
      </div>
    </FloatingPanel>
  );
});

PadPocketPanel.displayName = "PadPocketPanel";

export default PadPocketPanel;
