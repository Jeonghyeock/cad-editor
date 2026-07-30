// 스케치 모드 키보드 단축키 핸들러
// InputCanvas에서 분리 — window 레벨 keydown 이벤트 등록

import { useEffect, useRef } from "react";

import { DeleteShapeCommand } from "../core/commands/DefinitionCommands";
import type { GlobalHistoryManager } from "../core/GlobalHistoryManager";
import type SetupScene from "../rendering/SetupScene";
import type { SerializedGeometry, SketchDrawToolType } from "../Setup.type";
import { AddGeometryCommand } from "../sketch/commands/AddGeometryCommand";
import { BatchCommand } from "../sketch/commands/BatchCommand";
import type { GeometryCommand } from "../sketch/commands/GeometryCommand";
import type { DimensionConstraintType } from "../sketch/constraints/ConstraintValidator";
import { isReferenceId } from "../sketch/SketchGeometryStore";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import type { DrawTool } from "../sketch/tools/DrawTool";
import { generateGeometryId } from "../utils/idGenerator";

// 기하 복제 + 오프셋 (복사/붙여넣기용)
const _offsetGeometry = (
  src: SerializedGeometry,
  newId: string,
  dx: number,
  dy: number,
): SerializedGeometry | null => {
  switch (src.type) {
    case "point":
      return { ...src, id: newId, x: src.x + dx, y: src.y + dy };
    case "line":
      return { ...src, id: newId, x1: src.x1 + dx, y1: src.y1 + dy, x2: src.x2 + dx, y2: src.y2 + dy };
    case "circle":
      return { ...src, id: newId, cx: src.cx + dx, cy: src.cy + dy };
    case "arc":
      return { ...src, id: newId, cx: src.cx + dx, cy: src.cy + dy };
    case "curve":
      return { ...src, id: newId, points: src.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "ellipse":
      return { ...src, id: newId, cx: src.cx + dx, cy: src.cy + dy };
    default:
      return null;
  }
};

type UseSketchKeyboardHandlerOptions = {
  viewMode: string;
  scene: SetupScene | null;
  getGeometryStore: () => SketchGeometryStore;
  getDrawTool: () => DrawTool | null;
  clipboardRef: React.MutableRefObject<SerializedGeometry[]>;
  pasteCountRef: React.MutableRefObject<number>;
  setDrawToolType: (type: SketchDrawToolType) => void;
  setDimensionMode: (mode: { type: DimensionConstraintType; defaultValue: number } | null) => void;
  onDeleteSelectedBodies?: () => void;
  onDeleteSelectedOperation?: () => void;
  globalHistory?: GlobalHistoryManager;
  requestFullRedraw?: () => void;
  /** Tab 키로 PreSelection 후보 순환 (CATIA Sketcher 동작) */
  onCycleHoverCandidate?: () => void;
  /** Enter 키로 활성 후보 confirm (= 클릭 효과) */
  onConfirmHoverCandidate?: () => void;
};

/**
 * 스케치 모드 키보드 단축키를 window 레벨에 등록하는 훅.
 *
 * 처리하는 키:
 * - Ctrl+S: 저장 요청 이벤트
 * - Home: Zoom to Fit
 * - Escape: 도구/선택 해제
 * - Delete/Backspace: 선택 삭제
 * - Q: construction 토글
 * - D: dimension 도구 토글
 * - Ctrl+A: 전체 선택
 * - Ctrl+C/X/V: 복사/잘라내기/붙여넣기
 * - P/L/R/C/A/V/T/F/M/O/X: 도구 전환 단축키
 */
export const useSketchKeyboardHandler = ({
  viewMode,
  scene,
  getGeometryStore,
  getDrawTool,
  clipboardRef,
  pasteCountRef,
  setDrawToolType,
  setDimensionMode,
  onDeleteSelectedBodies,
  onDeleteSelectedOperation,
  globalHistory,
  requestFullRedraw,
  onCycleHoverCandidate,
  onConfirmHoverCandidate,
}: UseSketchKeyboardHandlerOptions): void => {
  // requestFullRedraw를 ref로 래핑 (매 렌더 새 함수 → deps 변경 → listener 재등록 방지)
  const requestFullRedrawRef = useRef(requestFullRedraw);
  requestFullRedrawRef.current = requestFullRedraw;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 사용자 typing 우선 — input/textarea/select/contentEditable focus 시 단축키 모두
      // skip. 이 guard 없으면 'f' / Delete / Backspace / P/L/R/C/A/V/D/Q / Ctrl+C/V/A/X
      // 가 input typing 을 가로채는 회귀 (예: 'f' 입력 시 zoomToFit → canvas focus 빼앗김,
      // backspace 시 body 삭제, 'c' 입력 시 도구 전환 등).
      // Ctrl+S 는 OS-standard 라 예외 — 아래 분기에서 별도 return 처리.
      const target = e.target as HTMLElement | null;
      const isInputFocused = !!target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );
      const isCtrlS = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s";
      if (isInputFocused && !isCtrlS) {
        return;
      }

      // Ctrl+S: Electron menu accelerator가 저장 처리 — 여기서는 스킵
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        return;
      }

      // Zoom to Fit: Home 키 (모든 모드)
      if (e.key === "Home" && scene) {
        scene.zoomToFit();
        return;
      }

      // 3D 모드 키보드 처리
      if (viewMode !== "2d-section") {
        if (e.key === "Escape" && scene) {
          scene.deselectBody();
          scene.highlightBakedSketchFaces([]);
        }
        if ((e.key === "Delete" || e.key === "Backspace") && scene) {
          // 선택된 body 삭제
          if (scene.selectedBodies.length > 0) {
            onDeleteSelectedBodies?.();
          } else {
            // 선택된 operation 삭제
            onDeleteSelectedOperation?.();
          }
        }
        if (e.key === "f" || e.key === "F") {
          scene?.zoomToFit();
        }
        // CATIA PreSelection Navigator — 3D 모드도 Tab/Enter 지원 (sketch 와 동일 패턴).
        // 통합 cycle/confirm 콜백이 sketchMode 에 따라 sketch/3D 분기.
        if (e.key === "Tab" && onCycleHoverCandidate) {
          const target = e.target as HTMLElement | null;
          const tag = target?.tagName;
          const isInputFocused = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
          if (!isInputFocused) {
            e.preventDefault();
            onCycleHoverCandidate();
          }
        }
        if (e.key === "Enter" && onConfirmHoverCandidate) {
          const target = e.target as HTMLElement | null;
          const tag = target?.tagName;
          const isInputFocused = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
          if (!isInputFocused) {
            e.preventDefault();
            onConfirmHoverCandidate();
          }
        }
        return;
      }

      const geoStore = getGeometryStore();
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      // Tab: CATIA PreSelection Navigator — 같은 위치 후보 순환
      // input/textarea/contenteditable에 포커스가 있으면 기본 포커스 이동 동작 유지
      if (e.key === "Tab" && onCycleHoverCandidate) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const isInputFocused = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
        if (!isInputFocused) {
          e.preventDefault();
          onCycleHoverCandidate();
          return;
        }
      }

      // Enter: PreSelection Navigator 활성 후보 confirm (= 클릭 효과). Tab 으로 후보 바꿔둔
      // 상태에서 Enter 누르면 그 후보가 선택. input/textarea 포커스 시는 기본 동작 유지.
      if (e.key === "Enter" && onConfirmHoverCandidate) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const isInputFocused = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
        if (!isInputFocused) {
          e.preventDefault();
          onConfirmHoverCandidate();
          return;
        }
      }

      // Ctrl+C: 선택된 기하 복사
      if (isCtrlOrCmd && e.key.toLowerCase() === "c" && geoStore) {
        const ids = geoStore.selectedIds.filter((id) => !isReferenceId(id));
        if (ids.length > 0) {
          const copied: SerializedGeometry[] = [];
          for (const id of ids) {
            const g = geoStore.geometries.get(id);
            if (g && g.type !== "polygon") copied.push(structuredClone(g));
          }
          if (copied.length > 0) {
            clipboardRef.current = copied;
            pasteCountRef.current = 0;
          }
        }
        e.preventDefault();
        return;
      }

      // Ctrl+V: 붙여넣기 (오프셋 + 새 ID)
      if (isCtrlOrCmd && e.key.toLowerCase() === "v" && geoStore && clipboardRef.current.length > 0) {
        pasteCountRef.current++;
        const offset = pasteCountRef.current * 10;
        const cmds: GeometryCommand[] = [];
        const newIds: string[] = [];
        for (const src of clipboardRef.current) {
          const newId = generateGeometryId();
          newIds.push(newId);
          const cloned = _offsetGeometry(src, newId, offset, offset);
          if (cloned) cmds.push(new AddGeometryCommand(cloned));
        }
        if (cmds.length > 0) {
          geoStore.execute(new BatchCommand(cmds));
          geoStore.selection = newIds.map((id) => ({ kind: "geometry" as const, geomId: id }));
          geoStore.requestRender();
        }
        e.preventDefault();
        return;
      }

      // Ctrl+Z / Ctrl+Y: SetupToolbar 의 document keydown 리스너에서 처리 (중복 호출 방지).

      // Ctrl+A: 전체 선택
      if (isCtrlOrCmd && e.key.toLowerCase() === "a" && geoStore) {
        e.preventDefault();
        const allIds = [...geoStore.geometries.keys()].filter((id) => !isReferenceId(id));
        geoStore.selection = allIds.map((id) => ({ kind: "geometry" as const, geomId: id }));
        geoStore.requestRender();
        return;
      }

      // Ctrl+X: 잘라내기 (복사 + 삭제)
      if (isCtrlOrCmd && e.key.toLowerCase() === "x" && geoStore) {
        const ids = geoStore.selectedIds.filter((id) => !isReferenceId(id));
        if (ids.length > 0) {
          const copied: SerializedGeometry[] = [];
          for (const id of ids) {
            const g = geoStore.geometries.get(id);
            if (g && g.type !== "polygon") copied.push(structuredClone(g));
          }
          if (copied.length > 0) {
            clipboardRef.current = copied;
            pasteCountRef.current = 0;
          }
          geoStore.deleteSelected();
        }
        e.preventDefault();
        return;
      }

      // 도구 전환 단축키 (CATIA 스케처 호환) — Ctrl/Cmd 키 시 무시
      const toolKeyMap: Record<string, SketchDrawToolType> = {
        p: "point", l: "line", r: "rectangle", c: "circle", a: "arc", v: "curve",
        t: "trim", f: "fillet", m: "mirror", o: "offset", x: "corner",
      };
      const lowerKey = e.key.toLowerCase();
      if (!isCtrlOrCmd && lowerKey in toolKeyMap) {
        const target = toolKeyMap[lowerKey];
        // 같은 도구면 select로 토글
        const current = getDrawTool();
        setDrawToolType(current?.type === target ? "select" : target);
        return;
      }
      if (e.key === "Escape") {
        // DrawTool 활성 시: 진행 중 작업이 있으면 취소만 (도구 유지)
        const tool = getDrawTool();
        if (tool && geoStore) {
          const wasPending = tool.hasPendingWork();
          tool.onKeyDown(geoStore, e);
          if (wasPending) return; // 체인 취소만, 도구 유지
          setDrawToolType("select");
          return;
        }
        // select 모드: 선택 해제
        if (geoStore) {
          geoStore.selection = [];
          geoStore.selectedConstraintId = null;
          geoStore.hoveredItem = null;
          geoStore.requestRender();
        }
        return;
      }

      // D 키: dimension 도구 토글 (DimensionDrawTool 활성화)
      if (lowerKey === "d") {
        const current = getDrawTool();
        if (current?.type === "dimension") {
          setDrawToolType("select");
        } else {
          setDrawToolType("dimension");
        }
        return;
      }

      // Q 키: construction geometry 토글
      if ((e.key === "q" || e.key === "Q") && geoStore) {
        geoStore.toggleConstruction();
        return;
      }

      // DrawTool 활성 시 도구에 keyDown 전달
      const tool = getDrawTool();
      if (tool && geoStore) {
        tool.onKeyDown(geoStore, e);
        return;
      }

      // Delete/Backspace → 선택된 구속조건/shape/기하 삭제
      if ((e.key === "Delete" || e.key === "Backspace") && geoStore) {
        if (geoStore.selectedConstraintId) {
          geoStore.removeConstraintById(geoStore.selectedConstraintId);
          geoStore.selectedConstraintId = null;
          return;
        }
        // shape가 선택된 경우: shape + 구성 geometry + 관련 constraint 삭제 (undo 지원).
        // shape 는 selection 에서 kind: "face" 항목으로 저장됨 (selectedIds getter 는
        // kind: "geometry" 만 반환하므로 selectedIds 검사로는 절대 hit 안 됨).
        const selectedShapeIds = geoStore.selection
          .filter((s) => s.kind === "face")
          .map((s) => s.faceId);
        if (selectedShapeIds.length > 0) {
          for (const shapeId of selectedShapeIds) {
            const cmd = new DeleteShapeCommand(shapeId, geoStore, requestFullRedrawRef.current);
            if (globalHistory) globalHistory.executeCommand(cmd); else cmd.execute();
          }
          geoStore.selectedIds = [];
          return;
        }
        geoStore.deleteSelected();
        return;
      }

      // 구속조건/Dimension 키보드 단축키 제거 — 툴바에서만 접근 가능
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode, scene, setDrawToolType, setDimensionMode, clipboardRef, getDrawTool, getGeometryStore, pasteCountRef, onDeleteSelectedBodies, onDeleteSelectedOperation, globalHistory, onCycleHoverCandidate, onConfirmHoverCandidate]);
};
