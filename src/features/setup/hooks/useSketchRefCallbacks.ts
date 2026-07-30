// 스케치 모드 커맨드 콜백을 Jotai atom에 일괄 설정
// SetupCanvas 내부에서 호출 — 부모 컴포넌트 및 형제 컴포넌트가 atom을 구독하여 사용

import { useSetAtom } from "jotai";
import type React from "react";
import { useEffect, useRef } from "react";

import type SetupScene from "../rendering/SetupScene";
import { sketchCommandsAtom } from "../Setup.store";
import type { SketchDrawToolType, StepModelData } from "../Setup.type";
import { AddGeometryCommand } from "../sketch/commands/AddGeometryCommand";
import { BatchCommand } from "../sketch/commands/BatchCommand";
import { detectAutoConstraints } from "../sketch/constraints/AutoConstraintAnalyzer";
import type { DimensionConstraintType } from "../sketch/constraints/ConstraintValidator";
import { createConstraintFromSelection, createDimensionConstraint, findEquivalentConstraint } from "../sketch/constraints/ConstraintValidator";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import type { ChamferDrawTool } from "../sketch/tools/ChamferDrawTool";
import type { DrawTool, SketchInputFieldType } from "../sketch/tools/DrawTool";
import type { FilletDrawTool } from "../sketch/tools/FilletDrawTool";
import type { OffsetDrawTool } from "../sketch/tools/OffsetDrawTool";
import { extractBRepEdges } from "../step/BRepEdgeExtractor";
import { extractBRepEdgesNative } from "../step/BRepEdgeExtractorNative";
import { projectBRepEdgesToSketch } from "../step/BRepEdgeProjector";
import { projectModelEdgesToSketch } from "../step/EdgeProjector";
import { getOcctSync, getShape } from "../step/OcctWasmManager";
import { extractSilhouetteFromMesh } from "../step/SilhouetteExtractor";

type SketchRefCallbacksDeps = {
  // Refs
  geometryStoreRef: React.MutableRefObject<SketchGeometryStore>;
  activeDrawToolRef: React.MutableRefObject<DrawTool | null>;
  sceneRef: React.MutableRefObject<SetupScene | null>;

  // DrawTool 인스턴스 맵
  drawToolMap: Map<SketchDrawToolType, DrawTool>;

  // 모델 목록
  models: StepModelData[];
  // body 가시성 상태 (project edges에서 제외 판단용)
  deletedBodies: Map<string, Set<number>>;
  hiddenBodies: Map<string, Set<number>>;

  // Atom setters
  setDimensionMode: (mode: { type: DimensionConstraintType; defaultValue: number; editConstraintId?: string } | null) => void;
  setFilletMode: (mode: { defaultRadius: number } | null) => void;
  setFilletRadius: (r: number) => void;
  setChamferMode: (mode: { defaultDistance: number; defaultDistance2: number } | null) => void;
  setChamferDistance: (d: number) => void;
  setChamferDistance2: (d: number) => void;
  setOffsetMode: (mode: { defaultDistance: number } | null) => void;
  setOffsetDistance: (d: number) => void;

  // 현재 값 (Fillet/Chamfer/Offset 도구 입력 요청 콜백용)
  filletRadius: number;
  chamferDistance: number;
  chamferDistance2: number;
  offsetDistance: number;
};

/**
 * 스케치 관련 커맨드 콜백을 sketchCommandsAtom에 일괄 설정.
 * 매 렌더마다 동기 실행하여 최신 closure를 atom에 반영.
 */
export const useSketchRefCallbacks = ({
  geometryStoreRef,
  activeDrawToolRef,
  sceneRef,
  drawToolMap,
  models,
  deletedBodies,
  hiddenBodies,
  setDimensionMode,
  setFilletMode,
  setFilletRadius,
  setChamferMode,
  setChamferDistance,
  setChamferDistance2,
  setOffsetMode,
  setOffsetDistance,
  filletRadius,
  chamferDistance,
  chamferDistance2,
  offsetDistance,
}: SketchRefCallbacksDeps): void => {
  const setSketchCommands = useSetAtom(sketchCommandsAtom);
  // 모든 deps를 ref에 저장 — useEffect 내 콜백이 항상 최신 값을 참조
  const depsRef = useRef({
    geometryStoreRef, activeDrawToolRef, sceneRef, drawToolMap, models,
    deletedBodies, hiddenBodies, setDimensionMode,
  });
  depsRef.current = {
    geometryStoreRef, activeDrawToolRef, sceneRef, drawToolMap, models,
    deletedBodies, hiddenBodies, setDimensionMode,
  };

  // Fillet/Chamfer/Offset 도구의 입력 요청 콜백 설정 (부작용 — 매 렌더에서 갱신)
  {
    const filletTool = drawToolMap.get("fillet");
    if (filletTool && "onRequestRadiusInput" in filletTool) {
      (filletTool as FilletDrawTool).onRequestRadiusInput = () => {
        setFilletMode({ defaultRadius: filletRadius });
      };
    }
    const chamferTool = drawToolMap.get("chamfer");
    if (chamferTool && "onRequestDistanceInput" in chamferTool) {
      (chamferTool as ChamferDrawTool).onRequestDistanceInput = () => {
        setChamferMode({ defaultDistance: chamferDistance, defaultDistance2: chamferDistance2 });
      };
    }
    const offsetTool = drawToolMap.get("offset");
    if (offsetTool && "onRequestDistanceInput" in offsetTool) {
      (offsetTool as OffsetDrawTool).onRequestDistanceInput = () => {
        setOffsetMode({ defaultDistance: offsetDistance });
      };
    }
  }

  // 모든 커맨드 콜백을 atom에 설정 (useEffect로 렌더 루프 방지)
  useEffect(() => {
    setSketchCommands({
    // 구속조건 적용 (Toolbar에서 호출). 동일 selection 에 같은 구속이 이미 있으면 toggle off (제거).
    applyConstraint: (type) => {
      const geoStore = geometryStoreRef.current;
      const c = createConstraintFromSelection(type, geoStore);
      if (!c) return;
      const cstStore = geoStore.constraintStore;
      if (cstStore) {
        const existing = findEquivalentConstraint(c, cstStore.constraints);
        if (existing) {
          // 이미 같은 구속 존재 → 제거 (toggle off)
          geoStore.removeConstraintById(existing.id);
          return;
        }
      }
      // 과구속 방지: tryApplyConstraint로 사전 검증 후 적용
      geoStore.tryApplyConstraint(c);
    },

    // Auto Constraint: 선택된 기하에 감지된 모든 구속 일괄 적용
    autoConstraint: () => {
      const geoStore = geometryStoreRef.current;
      const selectedIds = geoStore.selectedIds;
      const candidates = detectAutoConstraints(geoStore, selectedIds);
      let applied = 0;
      for (const c of candidates) {
        if (geoStore.tryApplyConstraint(c)) {
          applied++;
        }
      }
      return applied;
    },

    // SpecTree 스케치 모드: 기하 선택 (ctrlKey=true 시 다중 선택)
    selectGeometry: (geomId, ctrlKey) => {
      const geoStore = geometryStoreRef.current;
      if (ctrlKey) {
        // Ctrl+클릭: 토글 방식 다중 선택
        const alreadySelected = geoStore.selection.some(
          (s) => s.kind === "geometry" && s.geomId === geomId,
        );
        if (alreadySelected) {
          geoStore.selection = geoStore.selection.filter(
            (s) => !(s.kind === "geometry" && s.geomId === geomId),
          );
        } else {
          geoStore.selection = [...geoStore.selection, { kind: "geometry", geomId }];
        }
      } else {
        geoStore.selection = [{ kind: "geometry", geomId }];
      }
      geoStore.selectedConstraintId = null;
      geoStore.requestRender();
    },

    // SpecTree 스케치 모드: 구속조건 선택
    selectConstraint: (constraintId) => {
      const geoStore = geometryStoreRef.current;
      geoStore.selection = [];
      geoStore.selectedConstraintId = constraintId;
      geoStore.requestRender();
    },

    // SpecTree 스케치 모드: 기하 삭제
    deleteGeometry: (geomId) => {
      const geoStore = geometryStoreRef.current;
      // 삭제 대상을 선택 후 deleteSelected 호출
      geoStore.selection = [{ kind: "geometry", geomId }];
      geoStore.deleteSelected();
    },

    // SpecTree 스케치 모드: construction 토글
    toggleConstruction: (geomId) => {
      const geoStore = geometryStoreRef.current;
      // 토글 대상을 선택 후 toggleConstruction 호출
      geoStore.selection = [{ kind: "geometry", geomId }];
      geoStore.toggleConstruction();
    },

    // SpecTree 스케치 모드: 구속조건 삭제
    deleteConstraint: (constraintId) => {
      const geoStore = geometryStoreRef.current;
      geoStore.removeConstraintById(constraintId);
    },

    // SpecTree 스케치 모드: 구속조건 더블클릭 (dimension 값 편집)
    doubleClickConstraint: (constraintId) => {
      const geoStore = geometryStoreRef.current;
      const constraint = geoStore.constraintStore?.constraints.get(constraintId);
      if (!constraint) return;
      const dimType = constraint.type as DimensionConstraintType;
      const dimensionTypes: DimensionConstraintType[] = [
        "distance", "horizontal_distance", "vertical_distance", "line_length", "angle",
        "line_angle", "radius", "diameter", "point_line_distance",
      ];
      if (dimensionTypes.includes(dimType)) {
        const currentValue = "value" in constraint ? (constraint as { value: number }).value : 0;
        geoStore.selectedConstraintId = constraintId;
        geoStore.requestRender();
        depsRef.current.setDimensionMode({
          type: dimType,
          defaultValue: currentValue,
          editConstraintId: constraintId,
        });
      }
    },

    // 구속조건 값 변경 (애니메이션/다중 편집 공용)
    constraintValueChange: (constraintId, value) => {
      const geoStore = geometryStoreRef.current;
      if (!geoStore.constraintStore) return;
      const existing = geoStore.constraintStore.constraints.get(constraintId);
      if (!existing || !("value" in existing)) return;
      // 구속 삭제 후 새 값으로 재생성 (솔버 반영)
      geoStore.constraintStore.removeConstraint(constraintId);
      const updated = { ...existing, value } as typeof existing;
      geoStore.constraintStore.addConstraint(updated);
      geoStore.solveConstraints();
      geoStore.markGeometryChanged();
      geoStore.recomputeFaces();
      geoStore.requestRender();
    },

    // Rigid Group(fix_together) 이름 변경 — label 필드만 업데이트 (솔버 영향 없음)
    renameRigidGroup: (constraintId, label) => {
      const geoStore = geometryStoreRef.current;
      if (!geoStore.constraintStore) return;
      const existing = geoStore.constraintStore.constraints.get(constraintId);
      if (!existing || existing.type !== "fix_together") return;
      const trimmed = label.trim();
      const updated = { ...existing, label: trimmed.length > 0 ? trimmed : undefined };
      geoStore.constraintStore.constraints.set(constraintId, updated);
      geoStore.constraintStore.requestRender();
      geoStore.requestRender();
    },

    // Rigid Group 해제 — 구속 자체를 제거 (참조 기하는 유지)
    dissolveRigidGroup: (constraintId) => {
      const geoStore = geometryStoreRef.current;
      if (!geoStore.constraintStore) return;
      const existing = geoStore.constraintStore.constraints.get(constraintId);
      if (!existing || existing.type !== "fix_together") return;
      geoStore.removeConstraintById(constraintId);
    },

    // 스케치 분석 데이터 getter
    getAnalysisData: () => {
      const geoStore = geometryStoreRef.current;
      const cStore = geoStore.constraintStore;
      return {
        geometries: geoStore.geometries,
        constraints: cStore?.constraints ?? new Map(),
        solveStatus: geoStore.solveStatus,
        dof: geoStore.dof,
      };
    },

    // Dimension confirm: 타입 + 값 → 기존 구속 편집 또는 새 구속 생성
    dimensionConfirm: (type, value) => {
      const geoStore = geometryStoreRef.current;

      // 기존 구속 편집: selectedConstraintId가 있으면 해당 구속의 값 변경
      const editId = geoStore.selectedConstraintId;
      if (editId && geoStore.constraintStore) {
        const existing = geoStore.constraintStore.constraints.get(editId);
        if (existing && "value" in existing) {
          // 기존 구속 삭제 후 새 값으로 재생성
          geoStore.removeConstraintById(editId);
          const updated = { ...existing, value } as typeof existing;
          geoStore.applyConstraint(updated);
          geoStore.selectedConstraintId = null;
          geoStore.requestRender();
          return;
        }
      }

      // 새 구속 생성
      const dimType = type as DimensionConstraintType;
      const c = createDimensionConstraint(dimType, geoStore, value);
      if (c) {
        const ok = geoStore.tryApplyConstraint(c);
        if (!ok) {
          // 상충 → 참조 전용(driven) dimension으로 추가 (수치만 표시)
          const refConstraint = { ...c, isReference: true } as typeof c & { isReference: true };
          geoStore.applyConstraint(refConstraint);
        }
        // Dimension confirm 후 선택 초기화 (다음 선택을 위해)
        geoStore.selectedIds = [];
        geoStore.selectedVertices = [];
        geoStore.requestRender();
      }
    },

    // Fillet confirm: 반경 값 → FilletDrawTool.applyFillet 호출
    filletConfirm: (radius) => {
      const geoStore = geometryStoreRef.current;
      const filletTool = drawToolMap.get("fillet");
      if (filletTool && "applyFillet" in filletTool) {
        (filletTool as FilletDrawTool).applyFillet(geoStore, radius);
        setFilletRadius(radius);
      }
      setFilletMode(null);
    },

    // Chamfer confirm: 거리 값 → ChamferDrawTool.applyChamfer 호출
    chamferConfirm: (distance, distance2) => {
      const geoStore = geometryStoreRef.current;
      const chamferTool = drawToolMap.get("chamfer");
      if (chamferTool && "applyChamfer" in chamferTool) {
        (chamferTool as ChamferDrawTool).applyChamfer(geoStore, distance, distance2);
        setChamferDistance(distance);
        if (distance2 !== undefined) setChamferDistance2(distance2);
      }
      setChamferMode(null);
    },

    // Fillet 프리뷰: 값 변경 시 결과 프리뷰 업데이트
    filletPreview: (radius) => {
      const geoStore = geometryStoreRef.current;
      const filletTool = drawToolMap.get("fillet");
      if (filletTool && "computePreview" in filletTool) {
        (filletTool as FilletDrawTool).computePreview(geoStore, radius);
      }
    },

    // Chamfer 프리뷰
    chamferPreview: (distance, distance2) => {
      const geoStore = geometryStoreRef.current;
      const chamferTool = drawToolMap.get("chamfer");
      if (chamferTool && "computePreview" in chamferTool) {
        (chamferTool as ChamferDrawTool).computePreview(geoStore, distance, distance2);
      }
    },

    // Offset confirm
    offsetConfirm: (distance) => {
      const geoStore = geometryStoreRef.current;
      const offsetTool = drawToolMap.get("offset");
      if (offsetTool && "applyOffset" in offsetTool) {
        (offsetTool as OffsetDrawTool).applyOffset(geoStore, distance);
        setOffsetDistance(distance);
      }
      setOffsetMode(null);
    },

    // Offset 프리뷰
    offsetPreview: (distance) => {
      const geoStore = geometryStoreRef.current;
      const offsetTool = drawToolMap.get("offset");
      if (offsetTool && "computePreview" in offsetTool) {
        (offsetTool as OffsetDrawTool).computePreview(geoStore, distance);
      }
    },

    // Project 3D Edges (B-Rep 기반 정확 투영)
    projectEdges: async () => {
      const geoStore = geometryStoreRef.current;
      const currentScene = sceneRef.current;
      if (!currentScene) return;

      // offset 적용된 plane basis 사용 (표준/face 평면 모두 정확)
      const basis = currentScene.getSketchPlaneBasis();
      const rawPlane = currentScene.getSketchPlane();
      if (!basis || !rawPlane) return;
      const plane = {
        origin: { x: basis.origin.x, y: basis.origin.y, z: basis.origin.z },
        normal: rawPlane.normal,
        u: { x: basis.u.x, y: basis.u.y, z: basis.u.z },
        v: { x: basis.v.x, y: basis.v.y, z: basis.v.z },
      };

      const { deletedBodies: currentDeletedBodies, hiddenBodies: currentHiddenBodies } = depsRef.current;
      const cmds: AddGeometryCommand[] = [];

      for (const model of depsRef.current.models) {
        // 삭제 + 숨김 body 인덱스 수집
        const excluded = new Set<number>();
        const deleted = currentDeletedBodies.get(model.id);
        if (deleted) for (const idx of deleted) excluded.add(idx);
        const hidden = currentHiddenBodies.get(model.id);
        if (hidden) for (const idx of hidden) excluded.add(idx);

        const excludedArr = [...excluded];
        const offset = currentScene.getModelOffset(model.id);
        const modelOffset = { x: offset.x, y: offset.y, z: offset.z };

        // Native Addon 우선 (nativeShapeHandle 사용)
        if (model.nativeShapeHandle != null) {
          try {
            const edges = await extractBRepEdgesNative(model.nativeShapeHandle, excludedArr.length > 0 ? excludedArr : undefined);
            const projectedGeoms = projectBRepEdgesToSketch(edges, plane, modelOffset);
            for (const geom of projectedGeoms) {
              if (!geoStore.geometries.has(geom.id)) {
                cmds.push(new AddGeometryCommand(geom));
              }
            }
            continue;
          } catch {
            // Native 실패 → WASM 폴백
          }
        }

        // WASM B-Rep shape 폴백
        const storedShape = getShape(model.id);
        if (storedShape) {
          const oc = getOcctSync();
          if (oc) {
            const edges = extractBRepEdges(oc, storedShape, excluded.size > 0 ? excluded : undefined);
            const projectedGeoms = projectBRepEdgesToSketch(edges, plane, modelOffset);
            for (const geom of projectedGeoms) {
              if (!geoStore.geometries.has(geom.id)) {
                cmds.push(new AddGeometryCommand(geom));
              }
            }
            continue;
          }
        }

        // 메시 기반 폴백
        const projectedGeoms = projectModelEdgesToSketch(model, plane, modelOffset, excluded.size > 0 ? excluded : undefined);
        for (const geom of projectedGeoms) {
          if (!geoStore.geometries.has(geom.id)) {
            cmds.push(new AddGeometryCommand(geom));
          }
        }
      }

      if (cmds.length > 0) {
        geoStore.execute(new BatchCommand(cmds));
      }
    },

    // Project 3D Silhouette Edges: 메시 기반 윤곽선 추출
    projectSilhouette: () => {
      const geoStore = geometryStoreRef.current;
      const currentScene = sceneRef.current;
      if (!currentScene) return;

      const basis = currentScene.getSketchPlaneBasis();
      const rawPlane = currentScene.getSketchPlane();
      if (!basis || !rawPlane) return;
      const plane = {
        origin: { x: basis.origin.x, y: basis.origin.y, z: basis.origin.z },
        normal: rawPlane.normal,
        u: { x: basis.u.x, y: basis.u.y, z: basis.u.z },
        v: { x: basis.v.x, y: basis.v.y, z: basis.v.z },
      };

      const { deletedBodies: currentDeletedBodies, hiddenBodies: currentHiddenBodies } = depsRef.current;
      const cmds: AddGeometryCommand[] = [];

      for (const model of depsRef.current.models) {
        const excluded = new Set<number>();
        const deleted = currentDeletedBodies.get(model.id);
        if (deleted) for (const idx of deleted) excluded.add(idx);
        const hidden = currentHiddenBodies.get(model.id);
        if (hidden) for (const idx of hidden) excluded.add(idx);

        const offset = currentScene.getModelOffset(model.id);
        const modelOffset = { x: offset.x, y: offset.y, z: offset.z };

        const silhouetteGeoms = extractSilhouetteFromMesh(
          model, plane, rawPlane.normal, modelOffset, excluded.size > 0 ? excluded : undefined,
        );
        for (const geom of silhouetteGeoms) {
          if (!geoStore.geometries.has(geom.id)) {
            cmds.push(new AddGeometryCommand(geom));
          }
        }
      }

      if (cmds.length > 0) {
        geoStore.execute(new BatchCommand(cmds));
      }
    },

    // Intersect 3D Elements: 현재 스케치 평면과 모든 STEP 모델의 교차선을 construction line으로 생성
    intersect3D: () => {
      const geoStore = geometryStoreRef.current;
      const currentScene = sceneRef.current;
      if (!currentScene) return;

      const plane = currentScene.getSketchPlane();
      if (!plane) return;

      const cmds: AddGeometryCommand[] = [];
      for (const model of depsRef.current.models) {
        const offset = currentScene.getModelOffset(model.id);
        const modelOffset = { x: offset.x, y: offset.y, z: offset.z };
        const projectedGeoms = projectModelEdgesToSketch(model, plane, modelOffset);
        for (const geom of projectedGeoms) {
          // construction line으로 변환
          const constructionGeom = { ...geom, isConstruction: true, id: `intersect3d_${geom.id}` };
          if (!geoStore.geometries.has(constructionGeom.id)) {
            cmds.push(new AddGeometryCommand(constructionGeom));
          }
        }
      }

      if (cmds.length > 0) {
        geoStore.execute(new BatchCommand(cmds));
      }
    },

    // Sketch Tools: draw tool 참조 제공
    getDrawTool: () => activeDrawToolRef.current,

    // Sketch Tools 좌표 입력 → draw tool에 클릭 시뮬레이션
    sketchToolsClick: (pos) => {
      const drawTool = activeDrawToolRef.current;
      const geoStore = geometryStoreRef.current;
      if (!drawTool || !geoStore) return;
      drawTool.onPointerDown(geoStore, pos, pos, new PointerEvent("pointerdown"));
      geoStore.requestRender();
    },

    // Sketch Tools 값 입력 확정 → 도구별 처리 또는 좌표 클릭 폴백
    sketchToolsApply: (values) => {
      const drawTool = activeDrawToolRef.current;
      const geoStore = geometryStoreRef.current;
      if (!drawTool || !geoStore) return;

      // 도구별 applyInputValues 먼저 시도
      const handled = drawTool.applyInputValues(geoStore, values as Partial<Record<SketchInputFieldType, number>>);
      if (handled) {
        geoStore.requestRender();
        return;
      }

      // 폴백: H/V가 있으면 좌표 클릭 시뮬레이션
      if (values.H !== undefined && values.V !== undefined) {
        const clickPos = { x: values.H, y: values.V };
        drawTool.onPointerDown(geoStore, clickPos, clickPos, new PointerEvent("pointerdown"));
        geoStore.requestRender();
      }
    },
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 마운트 시 1회만 설정, 콜백 내부에서 depsRef.current로 최신 값 참조
};
