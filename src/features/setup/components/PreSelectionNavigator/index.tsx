// CATIA Sketcher PreSelection Navigator — 마우스 정지 시 hit 후보 목록 표시
// Tab 키로 후보 순환 가능함을 시각적으로 안내. 후보가 2개 이상일 때만 노출.
// Sketch / 3D 모드 둘 다 대응 — atom 의 candidates 는 wrapper (source: "sketch" | "3d").

import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { setupPickCandidatesNavAtom, type PreSelectionCandidate } from "../../Setup.store";

const shortId = (id: string): string => {
  if (id.length <= 8) return id;
  return `…${id.slice(-6)}`;
};

const formatSketchLabel = (h: Extract<PreSelectionCandidate, { source: "sketch" }>["hit"]): string => {
  switch (h.kind) {
    case "vertex":
      return `Vertex • ${shortId(h.geomId)} v${h.vertexIndex}`;
    case "geometry":
      switch (h.geomSubKind) {
        case "axis":
          return `Axis • ${shortId(h.geomId)}`;
        case "point":
          return `Point • ${shortId(h.geomId)}`;
        default:
          return `Edge • ${shortId(h.geomId)}`;
      }
    case "face":
      return `Face • ${shortId(h.faceId)}`;
    case "constraint":
      return `Constraint • ${shortId(h.constraintId)}`;
  }
};

const format3DLabel = (h: Extract<PreSelectionCandidate, { source: "3d" }>["hit"]): string => {
  // PlaneHit (construction aid)
  if (h.source === "originPlane") return `Origin Plane • ${["XY", "YZ", "ZX"][h.index] ?? h.index}`;
  if (h.source === "referencePlane") return `Ref Plane • ${shortId(h.id)}`;
  // PickEntity (source + kind)
  switch (h.source) {
    case "step":
      switch (h.kind) {
        case "vertex":
          return `Vertex • ${shortId(h.modelId)} b${h.bodyIndex}/v${h.vertexIndex}`;
        case "edge":
          return `Edge • ${shortId(h.modelId)} b${h.bodyIndex}/e${h.edgeIndex}`;
        case "face":
          return `Face • ${shortId(h.modelId)} g${h.faceGroupId}`;
        case "volume":
          return `Body • ${shortId(h.modelId)} b${h.bodyIndex}`;
      }
      return "";
    case "sketch":
      return `Sketch Face • ${shortId(h.planeKey)}`;
    case "feature":
      return `Solid • ${shortId(h.operationId)}`;
  }
};

const formatLabel = (c: PreSelectionCandidate): string => {
  return c.source === "sketch" ? formatSketchLabel(c.hit) : format3DLabel(c.hit);
};

const PreSelectionNavigator = () => {
  const state = useAtomValue(setupPickCandidatesNavAtom);
  if (!state || state.candidates.length < 2) return null;

  // 화면 우측/하단 잘림 방지: 단순 offset만 적용 (clipping은 브라우저 viewport 기준)
  const offsetX = 16;
  const offsetY = 16;
  const left = state.screenX + offsetX;
  const top = state.screenY + offsetY;

  return (
    <div
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 200,
        pointerEvents: "none",
        background: "rgba(31, 34, 39, 0.96)",
        border: "1px solid #525861",
        borderRadius: 4,
        boxShadow: "2px 4px 10px rgba(0,0,0,0.45)",
        padding: "4px 0",
        fontSize: 12,
        fontFamily: "sans-serif",
        color: "#e5e8eb",
        minWidth: 180,
        maxWidth: 280,
      }}
    >
      <div style={{
        padding: "2px 8px 4px 8px",
        borderBottom: "1px solid #383c42",
        color: "#9199a1",
        fontSize: 12,
      }}>
        Tab to cycle ({state.activeIndex + 1}/{state.candidates.length})
      </div>
      {state.candidates.map((c, i) => {
        const active = i === state.activeIndex;
        return (
          <div
            key={`${c.source}-${i}`}
            style={{
              padding: "3px 8px",
              background: active ? "#339ee6" : "transparent",
              fontWeight: active ? 600 : 400,
              color: active ? "#ffffff" : "#d1d5d9",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {active && <span style={{ marginRight: 4 }}>▸</span>}
            {formatLabel(c)}
          </div>
        );
      })}
    </div>
  );
};

export default memo(PreSelectionNavigator);
