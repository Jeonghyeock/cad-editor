// Plane Definition 패널 (CATIA-style reference plane 생성)
// Face 선택 → offset, Edge 선택 → edge를 포함하는 평면

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useState } from "react";

import { useHistoricalAtom } from "../../hooks/useHistoricalAtom";
import { setupRefPlaneModeAtom, setupRefPlanePreviewAtom, setupReferencePlanesAtom, setupViewModeAtom } from "../../Setup.store";
import type { ReferencePlane, SketchPlane } from "../../Setup.type";
import { generateProjectionId } from "../../utils/idGenerator";

import FloatingPanel from "../FloatingPanel";

const PlaneDefinitionPanel = memo(() => {
  const [refPlaneMode, setRefPlaneMode] = useAtom(setupRefPlaneModeAtom);
  // 평면 생성은 통합 history 에 기록 — Ctrl+Z 가 직전의 다른 작업이 아니라 이 평면을 되돌리게.
  const [, setReferencePlanes] = useHistoricalAtom(setupReferencePlanesAtom, "referencePlanes");
  const setPreview = useSetAtom(setupRefPlanePreviewAtom);
  const viewMode = useAtomValue(setupViewModeAtom);

  // sketch 진입 등 3D 가 아닌 상태 진입 시 자동 cleanup — offset plane 생성은 3D 모드 전용
  useEffect(() => {
    if (viewMode !== "3d" && refPlaneMode) {
      setRefPlaneMode(null);
    }
  }, [viewMode, refPlaneMode, setRefPlaneMode]);

  const [offset, setOffset] = useState(10);
  const [reverseDirection, setReverseDirection] = useState(false);

  const handleOffsetChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) setOffset(val);
  }, []);

  // 현재 입력값 기준 결과 평면 계산 — preview / confirm 공통.
  // 현재는 "Offset from plane" 만 지원 — base plane + offset.
  const computeNewPlane = useCallback((): { plane: SketchPlane; desc: string } | null => {
    if (!refPlaneMode?.basePlane) return null;
    const base = refPlaneMode.basePlane;
    const dir = reverseDirection ? -1 : 1;
    const d = offset * dir;
    return {
      plane: {
        origin: {
          x: base.origin.x + base.normal.x * d,
          y: base.origin.y + base.normal.y * d,
          z: base.origin.z + base.normal.z * d,
        },
        normal: base.normal,
        u: base.u,
        v: base.v,
      },
      desc: `Offset ${Math.abs(offset)}mm from ${refPlaneMode.basePlaneName ?? "plane"}${reverseDirection ? " (reversed)" : ""}`,
    };
  }, [refPlaneMode, offset, reverseDirection]);

  // 입력값 / 선택 변경 시 preview 갱신
  useEffect(() => {
    const result = computeNewPlane();
    setPreview(result ? result.plane : null);
  }, [computeNewPlane, setPreview]);

  // unmount 시 preview cleanup
  useEffect(() => {
    return () => { setPreview(null); };
  }, [setPreview]);

  const handleConfirm = useCallback(() => {
    if (!refPlaneMode) return;
    const computed = computeNewPlane();
    if (!computed) return;
    const newPlane: SketchPlane = computed.plane;
    const sourceDesc = computed.desc;

    const refPlane: ReferencePlane = {
      id: generateProjectionId(),
      name: `Plane.${Date.now() % 1000}`,
      plane: newPlane,
      creationMethod: "offset",
      sourceDescription: sourceDesc,
    };

    setReferencePlanes((prev) => [...prev, refPlane]);
    setRefPlaneMode(null);
  }, [refPlaneMode, computeNewPlane, setReferencePlanes, setRefPlaneMode]);

  const handleCancel = useCallback(() => {
    setRefPlaneMode(null);
  }, [setRefPlaneMode]);

  if (!refPlaneMode || viewMode !== "3d") return null;

  const isSelecting = refPlaneMode.step === "select-plane";
  const hasSelection = !!refPlaneMode.basePlane;

  return (
    <FloatingPanel
      title="Plane Definition"
      onClose={handleCancel}
      width={280}
      initialCorner="bottom-right"
      className="input__pad-pocket-panel"
      footer={
        <>
          <button type="button" className="input__floating-panel__btn input__floating-panel__btn--secondary" onClick={handleCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="input__floating-panel__btn"
            onClick={handleConfirm}
            disabled={!hasSelection}
          >
            OK
          </button>
        </>
      }
    >
        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Plane type</label>
          <select
            className="input__pad-pocket-panel__input"
            value="offset"
            disabled
          >
            <option value="offset">Offset from plane</option>
          </select>
        </div>

        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Reference</label>
          <div
            className="input__pad-pocket-panel__input"
            style={{
              fontStyle: isSelecting && !hasSelection ? "italic" : "normal",
              opacity: isSelecting && !hasSelection ? 0.7 : 1,
            }}
          >
            {isSelecting && !hasSelection
              ? "No selection"
              : refPlaneMode.basePlaneName ?? "Selected"}
          </div>
        </div>

        {/* CATIA 식 fixed layout — offset / reverse 항상 표시, base selection 전엔 disabled. */}
        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Offset (mm)</label>
          <input
            type="number"
            className="input__pad-pocket-panel__input"
            value={offset}
            onChange={handleOffsetChange}
            step={1}
            disabled={!hasSelection}
          />
        </div>

        <div className="input__pad-pocket-panel__field">
          <label className="input__pad-pocket-panel__label">Reverse Direction</label>
          <input
            type="checkbox"
            checked={reverseDirection}
            onChange={(e) => setReverseDirection(e.target.checked)}
            disabled={!hasSelection}
          />
        </div>
    </FloatingPanel>
  );
});

PlaneDefinitionPanel.displayName = "PlaneDefinitionPanel";

export default PlaneDefinitionPanel;
