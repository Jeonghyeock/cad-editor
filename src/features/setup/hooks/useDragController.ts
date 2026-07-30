// 드래그 제어: 박스 선택, vertex 이동, body 이동, coincident 체인 솔브

import { useCallback, useRef } from "react";

import type SetupScene from "../rendering/SetupScene";
import type { SelectionItem, SerializedGeometry, VertexHandle } from "../Setup.type";
import { DragSnapshotCommand, type DragSideEffect } from "../sketch/commands/DragSnapshotCommand";
import { translateGeometry } from "../sketch/commands/MoveGeometryCommand";
import { moveVertex } from "../sketch/commands/MoveVertexCommand";
import { computeDimensionLabelReference } from "../sketch/constraints/ConstraintValidator";
import type { SketchConstraint } from "../sketch/constraints/SketchConstraint.type";
import { isDimensionalConstraint } from "../sketch/constraints/SketchConstraint.type";
import { makePointKey } from "../sketch/constraints/SketchConstraintSolver";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import type { DrawTool } from "../sketch/tools/DrawTool";
import { getVertexCoord } from "../utils/geometryUtils";

/** Signed shoelace area (polygon vertices). 부호는 winding direction, 절댓값이 면적. */
const polyArea = (verts: { x: number; y: number }[]): number => {
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const c = verts[i], n = verts[(i + 1) % verts.length];
    a += c.x * n.y - n.x * c.y;
  }
  return a / 2;
};

// BFS로 coincident 체인의 모든 연결된 점 찾기 (전이적 탐색)
export const findCoincidentChain = (
  startKey: string,
  constraints: Map<string, SketchConstraint>,
): { geomId: string; vertexIndex: number }[] => {
  const visited = new Set<string>();
  const queue = [startKey];
  visited.add(startKey);
  const results: { geomId: string; vertexIndex: number }[] = [];

  while (queue.length > 0) {
    const key = queue.shift()!;
    const sepIdx = key.lastIndexOf(":");
    results.push({ geomId: key.slice(0, sepIdx), vertexIndex: parseInt(key.slice(sepIdx + 1), 10) });

    for (const c of constraints.values()) {
      if (c.type !== "coincident") continue;
      const aKey = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
      const bKey = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
      if (aKey === key && !visited.has(bKey)) { visited.add(bKey); queue.push(bKey); }
      else if (bKey === key && !visited.has(aKey)) { visited.add(aKey); queue.push(aKey); }
    }
  }
  return results;
};

export type DragState = {
  isDragging: boolean;
  startPos: { x: number; y: number };
  lastPos: { x: number; y: number };
  ids: string[];
  vertexHandle: VertexHandle | null; // null이면 전체 이동
  shapeId: string | null; // Shape 드래그 (face 면 드래그)
  /** Dimension constraint 드래그 — 라벨 위치 (labelPos) 만 update. */
  dimensionConstraintId?: string | null;
  /** Drag 시작 시 labelPos 초기 위치 (delta 계산용). */
  dimensionLabelStart?: { x: number; y: number } | null;
  // 드래그 시작 시 기하 스냅샷 (절대 좌표 방식 — 피드백 루프 방지)
  geoSnapshot: Map<string, SerializedGeometry> | null;
  // 드래그 시작 시 전체 기하 스냅샷 (undo용)
  fullSnapshot: Map<string, SerializedGeometry> | null;
  /**
   * Drag 시작 시 drag vertex 가 속한 shape 들의 area (signed shoelace) 절댓값.
   * 매 frame solver 결과의 area 와 비교해 degenerate (도형이 너무 작아짐) detection.
   * 첫 drag frame 에서 채워짐 (초기화 시 미존재 OK — optional).
   */
  shapeStartArea?: Map<string, number> | null;
  /**
   * 직전 valid frame 의 모든 geometry snapshot. degenerate detection 으로 reject 된 frame
   * 에서 이 state 로 복원해 visual 점프 방지. 첫 drag frame 에서 fullSnapshot 으로 초기화
   * + 매 유효 frame 마다 갱신 (초기화 시 미존재 OK — optional).
   */
  lastValidState?: Map<string, SerializedGeometry> | null;
};

export type UseDragControllerOptions = {
  getGeometryStore: (() => SketchGeometryStore | null) | undefined;
  getDrawTool?: () => DrawTool | null;
  /**
   * 드래그 완료 시 콜백 (EE pose 동기화 등).
   * 반환된 `DragSideEffect` 가 있으면 DragSnapshotCommand 와 atomic 하게 묶여 undo/redo
   * 시 함께 호출됨 (예: timelineScenes targetMotion 복원).
   */
  onDragComplete?: (draggedIds: string[]) => DragSideEffect | void;
  /** Play / Manual 등 시뮬레이션 중 (= !== "idle") 이면 drag 처리 차단. */
  getIsPlaybackBlocked?: () => boolean;
};

export const useDragController = (
  scene: SetupScene | null,
  opts: UseDragControllerOptions,
) => {
  const { getGeometryStore, getDrawTool, onDragComplete, getIsPlaybackBlocked } = opts;

  const dragRef = useRef<DragState | null>(null);

  // 드래그 이동 처리 (pointerMove에서 호출)
  const handleDragMove = useCallback(
    (vec2: { x: number; y: number }) => {
      if (!scene) return false;
      // Play / Manual 중엔 drag 차단 — 매 frame 좌표 mutation / constraint solve 부담 회피.
      if (getIsPlaybackBlocked?.()) return false;

      const drag = dragRef.current;
      const selectStore = getGeometryStore?.();
      if (!drag || !selectStore) return false;

      // Dimension 드래그 — labelPos / labelOffset update, geometry 변경 없음
      if (drag.dimensionConstraintId) {
        const start = drag.dimensionLabelStart;
        const cstStore = selectStore.constraintStore;
        if (start && cstStore) {
          const c = cstStore.constraints.get(drag.dimensionConstraintId);
          // dimensional constraint 만 labelPos / labelOffset 보유 — type predicate 로 narrow.
          if (c && isDimensionalConstraint(c)) {
            const dx = vec2.x - drag.startPos.x;
            const dy = vec2.y - drag.startPos.y;
            const newAbs = { x: start.x + dx, y: start.y + dy };
            c.labelPos = newAbs;
            // labelOffset (상대) 동기화 — 기하 reference 기준으로 재계산
            const ref = computeDimensionLabelReference(c, selectStore.geometries);
            if (ref) {
              c.labelOffset = { x: newAbs.x - ref.x, y: newAbs.y - ref.y };
            }
            drag.isDragging = true;
            drag.lastPos = { x: vec2.x, y: vec2.y };
            selectStore.requestRender();
          }
        }
        return true;
      }

      // 박스 선택 모드 (ids 빈 배열 + vertexHandle null)
      if (drag.ids.length === 0 && !drag.vertexHandle) {
        drag.isDragging = true;
        drag.lastPos = { x: vec2.x, y: vec2.y };
        const geoOverlay = scene.getGeometryOverlay();
        if (geoOverlay) geoOverlay.setSelectionBox(drag.startPos, drag.lastPos);
        return true;
      }

      const dx = vec2.x - drag.lastPos.x;
      const dy = vec2.y - drag.lastPos.y;
      if (Math.abs(dx) <= 1e-8 && Math.abs(dy) <= 1e-8) return true;

      drag.isDragging = true;

      // 첫 드래그 프레임: 원본 기하 스냅샷 저장 (coincident 짝 포함)
      if (!drag.geoSnapshot) {
        // 전체 기하 스냅샷 (undo용 — 드래그 시작 시점의 완전한 상태)
        drag.fullSnapshot = new Map();
        for (const [fid, fg] of selectStore.geometries) {
          drag.fullSnapshot.set(fid, structuredClone(fg));
        }
        // 직전 valid state — degenerate detection reject 시 복원. 첫 frame 은 시작 state.
        drag.lastValidState = new Map();
        for (const [fid, fg] of selectStore.geometries) {
          drag.lastValidState.set(fid, structuredClone(fg));
        }
        // drag vertex 가 속한 shape 들의 시작 area — solver 결과가 너무 작아진 frame 식별용.
        drag.shapeStartArea = new Map();
        if (drag.vertexHandle) {
          const vhId = drag.vertexHandle.geomId;
          for (const shape of selectStore.shapes) {
            if (!shape.lineIds.includes(vhId)) continue;
            drag.shapeStartArea.set(shape.id, Math.abs(polyArea(shape.vertices)));
          }
        }
        drag.geoSnapshot = new Map();
        const ids = drag.vertexHandle ? [drag.vertexHandle.geomId] : drag.ids;
        for (const id of ids) {
          const g = selectStore.geometries.get(id);
          if (g) drag.geoSnapshot.set(id, structuredClone(g));
        }
        // vertex 드래그: coincident 체인(전이적)으로 연결된 모든 기하를 스냅샷에 포함
        if (drag.vertexHandle && selectStore.constraintStore) {
          const vhKey = makePointKey(drag.vertexHandle.geomId, drag.vertexHandle.vertexIndex);
          const chain = findCoincidentChain(vhKey, selectStore.constraintStore.constraints);
          for (const pt of chain) {
            if (!drag.geoSnapshot.has(pt.geomId)) {
              const pg = selectStore.geometries.get(pt.geomId);
              if (pg) drag.geoSnapshot.set(pt.geomId, structuredClone(pg));
            }
          }
        }
        // drag 가 vertex 기반이면 selection 에 vertex 추가 — drag 중 시각 피드백.
        // pointerDown 에서 안 한 이유: handleDragEnd 의 click toggle 분기가 즉시 deselect 처리.
        // drag 가 일어난 시점 (handleDragMove 진입) 부턴 click 이 아니므로 안전.
        if (drag.vertexHandle) {
          const vh = drag.vertexHandle;
          selectStore.selection = [{
            kind: "vertex",
            geomId: vh.geomId,
            vertexIndex: vh.vertexIndex,
            x: vh.x,
            y: vh.y,
          }];
          selectStore.selectedConstraintId = null;
        }
      }

      // 절대 좌표 방식: 시작 위치 기준 총 이동량
      const totalDx = vec2.x - drag.startPos.x;
      const totalDy = vec2.y - drag.startPos.y;

      // 드래그 대상만 절대 좌표로 이동
      if (drag.vertexHandle) {
        const vh = drag.vertexHandle;
        const original = drag.geoSnapshot.get(vh.geomId);
        if (original) {
          selectStore.geometries.set(vh.geomId, moveVertex(original, vh.vertexIndex, totalDx, totalDy));
        }
        // coincident 체인의 모든 점도 같은 위치로 이동 — 단 reference 기하 (REF_ORIGIN_ID,
        // REF_X_AXIS_ID, REF_Y_AXIS_ID) 는 불변이어야 하므로 제외. 사각형 vertex 가 origin
        // 에 coincident 인 채 드래그될 때 origin 도 함께 mouse 위치로 끌리는 문제 해결.
        //
        // 주의: shape 전체 평행이동 starting-point hint 는 추가하지 않는다. Rectangle 처럼
        // horizontal/vertical 로 형태가 강하게 유지되는 도형에서 hint 가 평행이동 해를 너무
        // 강하게 favor 해 사용자가 corner 만 끌어도 사각형 전체가 평행이동하는 부작용 발생.
        // Parallelogram 등의 degenerate 점프는 degenerate detection (AREA_MIN_RATIO) 으로
        // 별도 차단 — 같은 효과를 다른 메커니즘으로.
        if (selectStore.constraintStore) {
          const vhKey = makePointKey(vh.geomId, vh.vertexIndex);
          const chain = findCoincidentChain(vhKey, selectStore.constraintStore.constraints);
          for (const pt of chain) {
            if (pt.geomId === vh.geomId && pt.vertexIndex === vh.vertexIndex) continue;
            const ptGeom = selectStore.geometries.get(pt.geomId);
            if (ptGeom && "isReference" in ptGeom && ptGeom.isReference) continue;
            const pOriginal = drag.geoSnapshot.get(pt.geomId);
            if (pOriginal) {
              selectStore.geometries.set(pt.geomId, moveVertex(pOriginal, pt.vertexIndex, totalDx, totalDy));
            }
          }
        }
      } else {
        for (const id of drag.ids) {
          const original = drag.geoSnapshot.get(id);
          if (!original) continue;

          // circle/ellipse body 드래그: scale 방식 반지름 변경 (shape 드래그가 아닌 경우에만)
          if ((original.type === "circle" || original.type === "ellipse") && drag.ids.length === 1 && !drag.shapeId) {
            const origDist = Math.hypot(drag.startPos.x - original.cx, drag.startPos.y - original.cy);
            const newDist = Math.hypot(vec2.x - original.cx, vec2.y - original.cy);
            const scale = origDist > 1e-6 ? newDist / origDist : 1;
            if (original.type === "circle") {
              selectStore.geometries.set(id, { ...original, r: Math.max(0.1, original.r * scale) });
            } else {
              selectStore.geometries.set(id, { ...original, rx: Math.max(0.1, original.rx * scale), ry: Math.max(0.1, original.ry * scale) });
            }
          } else {
            selectStore.geometries.set(id, translateGeometry(original, totalDx, totalDy));
          }
        }
      }
      drag.lastPos = { x: vec2.x, y: vec2.y };

      // 구속조건 라이브 솔브
      if (selectStore.constraintStore && selectStore.constraintStore.constraints.size > 0) {
        // 드래그 중인 점 + coincident로 연결된 점들 고정
        const fixedKeys = new Set<string>();
        if (drag.vertexHandle) {
          const vh = drag.vertexHandle;
          const vhKey = makePointKey(vh.geomId, vh.vertexIndex);
          fixedKeys.add(vhKey);
          // 전이적 coincident chain 전체를 고정 (BFS) — reference 기하는 solver 가 자체적으로
          // stored 좌표 (REF_ORIGIN_ID → (0,0)) 로 fix 하므로 fixedKeys 에 추가하지 않음.
          // 추가하면 drag 좌표 보정 (SketchConstraintSolver fixedPointKeys 갱신) 이 reference
          // 의 stored 좌표를 mouse 위치로 override 해 origin / axis 가 함께 움직임.
          if (selectStore.constraintStore) {
            const chain = findCoincidentChain(vhKey, selectStore.constraintStore.constraints);
            for (const pt of chain) {
              const ptGeom = selectStore.geometries.get(pt.geomId);
              if (ptGeom && "isReference" in ptGeom && ptGeom.isReference) continue;
              fixedKeys.add(makePointKey(pt.geomId, pt.vertexIndex));
            }
          }
        } else {
          // 전체 기하 이동: 선택된 기하의 모든 꼭짓점을 고정
          for (const id of drag.ids) {
            const g = selectStore.geometries.get(id);
            if (!g) continue;
            switch (g.type) {
              case "point": fixedKeys.add(makePointKey(id, 0)); break;
              case "line": fixedKeys.add(makePointKey(id, 0)); fixedKeys.add(makePointKey(id, 1)); break;
              case "circle": fixedKeys.add(makePointKey(id, 0)); break;
              case "arc": fixedKeys.add(makePointKey(id, 0)); fixedKeys.add(makePointKey(id, 1)); fixedKeys.add(makePointKey(id, 2)); break;
              case "curve": g.points.forEach((_, i) => fixedKeys.add(makePointKey(id, i))); break;
              case "ellipse": fixedKeys.add(makePointKey(id, 0)); break;
              case "polygon": g.vertices.forEach((_, i) => fixedKeys.add(makePointKey(id, i))); break;
            }
          }
        }
        selectStore.solveLive(fixedKeys);

        // 솔버 over-constrained — drag 대상이 fully-constrained 라 mouse 위치를 만족할 수
        // 없는 경우. drag 변경 (mouse 따라 임시 이동시킨 좌표) 을 fullSnapshot 으로 복원해
        // visual 상 vertex 가 움직이지 않게 한다 (CATIA 식 — fully-constrained vertex 는
        // 드래그 거부). 다음 frame 도 같은 상태면 동일 복원 반복.
        if (selectStore.solveStatus === "over-constrained" && drag.fullSnapshot) {
          for (const [fid, fg] of drag.fullSnapshot) {
            selectStore.geometries.set(fid, structuredClone(fg));
          }
          selectStore.refreshShapeVertices();
          selectStore.markGeometryChanged();
          selectStore.requestRender();
          return true;
        }

        // 솔버 후 coincident 검증: 분리된 경우 fullSnapshot에서 복구 후 재시도
        if (selectStore.constraintStore && drag.fullSnapshot) {
          const COIN_TOL = 0.5;
          let broken = false;
          for (const c of selectStore.constraintStore.constraints.values()) {
            if (c.type !== "coincident") continue;
            const gA = selectStore.geometries.get(c.pointA.geomId);
            const gB = selectStore.geometries.get(c.pointB.geomId);
            if (!gA || !gB) continue;
            const pA = getVertexCoord(gA, c.pointA.vertexIndex);
            const pB = getVertexCoord(gB, c.pointB.vertexIndex);
            if (pA && pB && Math.hypot(pA.x - pB.x, pA.y - pB.y) > COIN_TOL) {
              broken = true;
              break;
            }
          }
          if (broken) {
            // fullSnapshot에서 전체 복원 후 드래그 대상 재적용 + 재솔브
            for (const [fid, fg] of drag.fullSnapshot) {
              selectStore.geometries.set(fid, structuredClone(fg));
            }
            if (drag.vertexHandle) {
              const vh = drag.vertexHandle;
              const original = drag.geoSnapshot.get(vh.geomId);
              if (original) selectStore.geometries.set(vh.geomId, moveVertex(original, vh.vertexIndex, totalDx, totalDy));
              if (selectStore.constraintStore) {
                const vhKey = makePointKey(vh.geomId, vh.vertexIndex);
                const chain = findCoincidentChain(vhKey, selectStore.constraintStore.constraints);
                for (const pt of chain) {
                  if (pt.geomId === vh.geomId && pt.vertexIndex === vh.vertexIndex) continue;
                  const po = drag.geoSnapshot.get(pt.geomId);
                  if (po) selectStore.geometries.set(pt.geomId, moveVertex(po, pt.vertexIndex, totalDx, totalDy));
                }
              }
            } else {
              // body/shape drag: 이동 재적용
              for (const id of drag.ids) {
                const original = drag.geoSnapshot.get(id);
                if (original) selectStore.geometries.set(id, translateGeometry(original, totalDx, totalDy));
              }
            }
            selectStore.solveLive(fixedKeys);
          }
        }

        // Degenerate detection — solver 가 multiple solution 중 도형이 너무 작아진 (얇은
        // parallelogram 등) 해로 점프하는 케이스. drag vertex 가 속한 shape 들의 현재 area 가
        // 시작 area 의 일정 비율 이하면 reject + 직전 valid state 로 복원.
        // 다음 frame 의 mouse 위치에서 다시 시도 — mouse 가 자연스러운 deformation 방향으로
        // 가면 통과. 즉 사용자가 도형 deform 가능한 방향으론 자유로움, degenerate 방향만 차단.
        //
        // Trade-off: solver 점프 차단 vs 의도적 축소 (사용자가 도형을 20% 이하 크기로 끌고
        // 가고 싶을 때) 둘을 구분할 수 없는 휴리스틱. 0.2 는 보수적 시작값 — 너무 자주 막히면
        // 0.1 로, 점프가 여전히 발생하면 0.4 로 조정.
        const AREA_MIN_RATIO = 0.2;
        let degenerate = false;
        if (drag.vertexHandle && drag.shapeStartArea && drag.shapeStartArea.size > 0) {
          for (const shape of selectStore.shapes) {
            const startArea = drag.shapeStartArea.get(shape.id);
            if (startArea === undefined || startArea < 1e-6) continue;
            const currArea = Math.abs(polyArea(shape.vertices));
            if (currArea < startArea * AREA_MIN_RATIO) {
              degenerate = true;
              break;
            }
          }
        }
        if (degenerate && drag.lastValidState) {
          for (const [fid, fg] of drag.lastValidState) {
            selectStore.geometries.set(fid, structuredClone(fg));
          }
          selectStore.refreshShapeVertices();
          selectStore.markGeometryChanged();
          selectStore.requestRender();
          return true;
        }
        // 유효 frame — lastValidState 갱신
        if (drag.lastValidState) {
          drag.lastValidState.clear();
          for (const [fid, fg] of selectStore.geometries) {
            drag.lastValidState.set(fid, structuredClone(fg));
          }
        }
      } else {
        selectStore.refreshShapeVertices();
        selectStore.markGeometryChanged();
        selectStore.requestRender();
      }

      return true;
    },
    [scene, getGeometryStore, getIsPlaybackBlocked],
  );

  // 드래그 완료 처리 (pointerUp에서 호출)
  // 반환: true면 드래그가 처리됨 (호출측에서 추가 처리 불필요)
  const handleDragEnd = useCallback(
    (vec2: { x: number; y: number }, e: React.PointerEvent<HTMLCanvasElement>): boolean => {
      const drag = dragRef.current;
      const geoStore = getGeometryStore?.();
      if (!drag || !geoStore) {
        dragRef.current = null;
        return false;
      }

      // Dimension drag 완료 — labelPos 이미 update 됨. 단순 정리.
      if (drag.dimensionConstraintId) {
        dragRef.current = null;
        return true;
      }

      // 박스 선택 완료
      if (drag.isDragging && drag.ids.length === 0 && !drag.vertexHandle) {
        const isWindow = drag.lastPos.x >= drag.startPos.x;
        const box = {
          minX: Math.min(drag.startPos.x, drag.lastPos.x),
          minY: Math.min(drag.startPos.y, drag.lastPos.y),
          maxX: Math.max(drag.startPos.x, drag.lastPos.x),
          maxY: Math.max(drag.startPos.y, drag.lastPos.y),
        };
        const { geometryIds, vertexHits } = geoStore.hitTestBox(box, isWindow);
        geoStore.selection = [
          ...geometryIds.map((id) => ({ kind: "geometry" as const, geomId: id })),
          ...vertexHits.map((v) => ({
            kind: "vertex" as const,
            geomId: v.geomId,
            vertexIndex: v.vertexIndex,
            x: v.x,
            y: v.y,
          })),
        ];
        geoStore.requestRender();
        if (scene) {
          const geoOverlay = scene.getGeometryOverlay();
          if (geoOverlay) geoOverlay.setSelectionBox(null, null);
        }
        dragRef.current = null;
        return true;
      }

      if (drag.isDragging) {
        const totalDx = drag.lastPos.x - drag.startPos.x;
        const totalDy = drag.lastPos.y - drag.startPos.y;
        if (Math.abs(totalDx) > 1e-6 || Math.abs(totalDy) > 1e-6) {
          // onDragComplete (EE pose 동기화 등) 가 외부 atom 변경 시 DragSideEffect 반환 →
          // DragSnapshotCommand 에 묶어 ctrl+z 한 번에 함께 복원.
          const sideEffectRaw = onDragComplete?.(drag.ids);
          const sideEffect: DragSideEffect | undefined = sideEffectRaw && typeof sideEffectRaw === "object"
            ? sideEffectRaw
            : undefined;
          if (drag.fullSnapshot) {
            const after = new Map<string, SerializedGeometry>();
            for (const [id, g] of geoStore.geometries) {
              after.set(id, structuredClone(g));
            }
            const cmd = new DragSnapshotCommand(drag.fullSnapshot, after, sideEffect);
            geoStore.pushSnapshot(cmd);
          }
        } else {
          onDragComplete?.(drag.ids);
        }

        dragRef.current = null;
        return true;
      }

      // 드래그 없이 vertex 클릭만 → 선택 처리
      if (drag.vertexHandle) {
        const vh = drag.vertexHandle;
        const isCtrl = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
        const dimActive = getDrawTool?.()?.type === "dimension";
        const isAdditive = isCtrl || dimActive;
        const vertexItem: SelectionItem = { kind: "vertex", geomId: vh.geomId, vertexIndex: vh.vertexIndex, x: vh.x, y: vh.y };

        const existingIdx = geoStore.selection.findIndex(
          (s) => s.kind === "vertex" && s.geomId === vh.geomId && s.vertexIndex === vh.vertexIndex,
        );

        if (isAdditive) {
          if (existingIdx >= 0) {
            geoStore.selection = geoStore.selection.filter((_, i) => i !== existingIdx);
          } else {
            geoStore.selection = [...geoStore.selection, vertexItem];
          }
        } else {
          geoStore.selection = existingIdx >= 0 ? [] : [vertexItem];
        }
        geoStore.selectedConstraintId = null;
        geoStore.requestRender();
        dragRef.current = null;
        return true;
      }

      dragRef.current = null;
      return false;
    },
    [scene, getGeometryStore, getDrawTool, onDragComplete],
  );

  // 포인터 취소 시 라이브 이동 되돌리기
  const handleDragCancel = useCallback(() => {
    const drag = dragRef.current;
    const geoStore = getGeometryStore?.();
    // 박스 선택 클리어
    if (scene) {
      const geoOverlay = scene.getGeometryOverlay();
      if (geoOverlay) geoOverlay.setSelectionBox(null, null);
    }
    if (drag && drag.isDragging && geoStore) {
      if (drag.fullSnapshot) {
        for (const [id, original] of drag.fullSnapshot) {
          geoStore.geometries.set(id, structuredClone(original));
        }
      } else if (drag.geoSnapshot) {
        for (const [id, original] of drag.geoSnapshot) {
          geoStore.geometries.set(id, original);
        }
      }
      geoStore.requestRender();
    }
    dragRef.current = null;
  }, [scene, getGeometryStore]);

  return {
    dragRef,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  };
};
