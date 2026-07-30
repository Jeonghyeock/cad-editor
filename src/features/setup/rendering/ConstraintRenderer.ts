// 구속조건 렌더링 (심볼, 아이콘, 라벨, 치수선, 히트 테스트)

import * as THREE from "three";

import { formatLengthDisplay } from "src/shared/utils/activeLengthUnit";

import type { SerializedGeometry } from "../Setup.type";
import { computeDimensionLiveValue, getEffectiveLabelPos } from "../sketch/constraints/ConstraintValidator";
import { isDimensionalConstraint, isDrivenDimension } from "../sketch/constraints/SketchConstraint.type";
import type { ConstraintPointRef, SketchConstraint } from "../sketch/constraints/SketchConstraint.type";
import type { DimensionDrawTool } from "../sketch/tools/DimensionDrawTool";

import {
  COLOR_CONSTRAINT,
  COLOR_DEPENDENCY,
  COLOR_DRIVEN_DIM,
  COLOR_SELECTED,
  CONSTRAINT_ICON_SIZE,
  CONSTRAINT_LABEL_SCREEN_HEIGHT,
  iconCache,
} from "./overlayConstants";
import type { OverlayRenderContext, OverlaySubRenderer } from "./OverlayRenderContext";

export class ConstraintRenderer implements OverlaySubRenderer {
  private _constraintObjects: Map<string, THREE.Object3D> = new Map();
  private _constraintPositions: Map<string, { x: number; y: number }> = new Map();
  // dimension 치수선 + 보조선 영역 (hitTest 확장용, 복수 segment)
  private _dimensionSegments: Map<string, { ax: number; ay: number; bx: number; by: number }[]> = new Map();
  // hoveredConstraintId는 store.hoveredItem에서 직접 관리

  /** 거리 기반 constraint hitTest (최근접 거리 + ID 반환) */
  hitTestConstraintWithDistance(ctx: OverlayRenderContext, pos: { x: number; y: number }, radius: number): { id: string; distance: number } | null {
    const candidates = this.hitTestConstraintCandidates(ctx, pos, radius);
    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * 거리 기반 constraint hit 후보 배열 (CATIA PreSelection Navigator 통합용).
   * 라벨 중심 + 치수선/보조선 segment까지의 최단 거리. 같은 ID는 중복 제거.
   */
  hitTestConstraintCandidates(_ctx: OverlayRenderContext, pos: { x: number; y: number }, radius: number): { id: string; distance: number }[] {
    const idToDist = new Map<string, number>();
    const update = (id: string, d: number) => {
      const prev = idToDist.get(id);
      if (prev === undefined || d < prev) idToDist.set(id, d);
    };
    // 라벨 중심
    for (const [id, p] of this._constraintPositions) {
      const d = Math.hypot(pos.x - p.x, pos.y - p.y);
      if (d < radius) update(id, d);
    }
    // 치수선 + 보조선
    for (const [id, segments] of this._dimensionSegments) {
      for (const seg of segments) {
        const sdx = seg.bx - seg.ax, sdy = seg.by - seg.ay;
        const len2 = sdx * sdx + sdy * sdy;
        if (len2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((pos.x - seg.ax) * sdx + (pos.y - seg.ay) * sdy) / len2));
        const px = seg.ax + t * sdx, py = seg.ay + t * sdy;
        const d = Math.hypot(pos.x - px, pos.y - py);
        if (d < radius) update(id, d);
      }
    }
    return [...idToDist.entries()]
      .map(([id, distance]) => ({ id, distance }))
      .sort((a, b) => a.distance - b.distance);
  }

  hitTestConstraint(ctx: OverlayRenderContext, pos: { x: number; y: number }, _radius: number): string | null {
    const r = ctx.worldPerPixel * (CONSTRAINT_LABEL_SCREEN_HEIGHT / 2);
    const r2 = r * r;
    // 라벨 중심 hitTest
    for (const [id, p] of this._constraintPositions) {
      const dx = pos.x - p.x;
      const dy = pos.y - p.y;
      if (dx * dx + dy * dy <= r2) return id;
    }
    // 치수선 + 보조선 hitTest (라벨 영역 밖이라도 선 위면 히트)
    const lineR = ctx.worldPerPixel * 5;
    const lineR2 = lineR * lineR;
    for (const [id, segments] of this._dimensionSegments) {
      for (const seg of segments) {
        const sdx = seg.bx - seg.ax, sdy = seg.by - seg.ay;
        const len2 = sdx * sdx + sdy * sdy;
        if (len2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((pos.x - seg.ax) * sdx + (pos.y - seg.ay) * sdy) / len2));
        const px = seg.ax + t * sdx, py = seg.ay + t * sdy;
        const d2 = (pos.x - px) * (pos.x - px) + (pos.y - py) * (pos.y - py);
        if (d2 <= lineR2) return id;
      }
    }
    return null;
  }

  updateHover(ctx: OverlayRenderContext, worldPos: { x: number; y: number } | null, hitRadius: number): void {
    const hitId = worldPos ? this.hitTestConstraint(ctx, worldPos, hitRadius) : null;
    if (ctx.store) {
      // 구속조건 hover만 store.hoveredItem에 반영 (기하/vertex hover가 아닌 경우)
      const current = ctx.store.hoveredItem;
      if (hitId) {
        ctx.store.hoveredItem = { kind: "constraint", constraintId: hitId };
      } else if (current?.kind === "constraint") {
        // 구속조건에서 빠져나온 경우만 null로 (기하/vertex hover는 건드리지 않음)
        ctx.store.hoveredItem = null;
      }
    }
  }

  sync(ctx: OverlayRenderContext): void {
    this._clearConstraintObjects(ctx);

    if (!ctx.constraintStore || !ctx.store || !ctx.sketchPlane) return;

    // 구속조건 표시 토글이 off면 렌더링 스킵 (히트 테스트용 위치만 유지)
    if (!ctx.constraintVisible) return;

    const selectedCId = ctx.store.selectedConstraintId;
    const filter = ctx.constraintFilter;

    for (const [id, constraint] of ctx.constraintStore.constraints) {
      const pos = this._getConstraintPosition(ctx, constraint);
      if (!pos) continue;

      // 타입별 표시 필터 (geometric/dimensional)
      const isDim = isDimensionalConstraint(constraint);
      if (isDim && !filter.dimensional) continue;
      if (!isDim && !filter.geometric) continue;

      // coincident: 심볼 + 히트 테스트 모두 비활성 (CATIA 스타일 — 위치 공유로 충분)
      if (constraint.type === "coincident") continue;

      // internal 구속 (EE 강체 distance 등): 렌더링 스킵
      if ("isInternal" in constraint && constraint.isInternal) continue;

      // 숨겨진 geometry를 참조하는 구속은 렌더링 스킵 (다른 씬의 SO)
      if (ctx.hiddenGeoIds.size > 0) {
        const refs = this._getConstraintGeomIds(constraint);
        if (refs.some((gid) => ctx.hiddenGeoIds.has(gid))) continue;
      }

      // point_on_line: hover 시에만 표시 (선택된 경우 제외)
      if (constraint.type === "point_on_line") {
        this._constraintPositions.set(id, this._getConstraintDisplayPosition(ctx, constraint, pos));
        if (id !== selectedCId) {
          const hi = ctx.store.hoveredItem;
          const hv = hi?.kind === "vertex" ? { geomId: hi.geomId, vertexIndex: hi.vertexIndex, x: hi.x, y: hi.y } : null;
          if (!hv || !this._constraintMatchesVertex(ctx, constraint, hv)) continue;
        }
      }

      const isSelected = id === selectedCId;
      const hovItem = ctx.store.hoveredItem;
      const isHovered = hovItem?.kind === "constraint" && hovItem.constraintId === id;
      const isDependency = !isSelected && !isHovered && ctx.dependencyConstraintIds.has(id);

      // 참조 전용(driven) dimension — enforced 와 동일한 dim/extension 라인 + 괄호 + 회색.
      // 라벨 값은 현재 기하에서 live 계산 (저장된 c.value 가 stale 이라도 정확).
      if (isDrivenDimension(constraint)) {
        const liveValue = computeDimensionLiveValue(constraint, ctx.store.geometries);
        const renderConstraint = liveValue !== null && "value" in constraint
          ? ({ ...constraint, value: liveValue } as SketchConstraint)
          : constraint;
        const dimGroup = this._createDimensionGroupByType(ctx, renderConstraint);
        if (dimGroup) {
          // 모든 sub-material 색상 → COLOR_DRIVEN_DIM (회색) 으로 override
          this._recolorGroup(dimGroup, COLOR_DRIVEN_DIM);
          // 라벨 sprite 의 텍스트를 (...) 로 감싸 새 sprite 로 교체
          this._wrapLabelInParens(ctx, dimGroup);
          this._addDimensionObject(ctx, id, pos, dimGroup, isSelected || isHovered);
          const dimPos = this._getDimensionLabelPos(ctx, renderConstraint);
          if (dimPos) this._constraintPositions.set(id, dimPos);
          this._dimensionSegments.set(id, this._extractSegmentsFromGroup(ctx, dimGroup));
        }
        continue;
      }

      // 치수 구속: 타입별 렌더 메서드 디스패치
      const dimGroup = this._createDimensionGroupByType(ctx, constraint);
      if (dimGroup) {
        this._addDimensionObject(ctx, id, pos, dimGroup, isSelected || isHovered);
        const dimPos = this._getDimensionLabelPos(ctx, constraint);
        if (dimPos) this._constraintPositions.set(id, dimPos);
        this._dimensionSegments.set(id, this._extractSegmentsFromGroup(ctx, dimGroup));
        continue;
      }

      const colorOverride = (isSelected || isHovered) ? COLOR_SELECTED : (isDependency ? COLOR_DEPENDENCY : undefined);
      const sprites = this._createConstraintSymbols(ctx, constraint, pos, colorOverride);
      if (sprites.length === 0) continue;

      const group = new THREE.Group();
      for (const s of sprites) group.add(s);
      group.name = `constraint-${id}`;
      group.traverse((child) => { child.renderOrder = 997; });
      ctx.group.add(group);
      this._constraintObjects.set(id, group);
      this._constraintPositions.set(id, this._getConstraintDisplayPosition(ctx, constraint, pos));
    }

    // Dimension 도구 프리뷰 렌더링 (placing 단계)
    this._renderDimensionPreview(ctx);
  }

  /** DimensionDrawTool의 previewConstraint를 임시 치수선으로 렌더링 */
  private _renderDimensionPreview(ctx: OverlayRenderContext): void {
    const tool = ctx.drawTool;
    if (!tool || tool.type !== "dimension") return;
    const dimTool = tool as DimensionDrawTool;
    const preview = dimTool.previewConstraint;
    if (!preview || !ctx.store) return;

    // previewConstraint → 임시 SketchConstraint 생성
    const tempConstraint = this._buildPreviewConstraint(ctx, preview);
    if (!tempConstraint) return;
    // labelPos 주입 (렌더러가 치수 텍스트 위치로 사용)
    (tempConstraint as Record<string, unknown>).labelPos = preview.labelPos;

    const dimGroup = this._createDimensionGroupByType(ctx, tempConstraint);
    if (dimGroup) {
      dimGroup.traverse((child) => {
        child.renderOrder = 997;
        if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Sprite) {
          const mat = (child as THREE.Mesh).material as THREE.Material;
          if (mat) { mat.transparent = true; mat.opacity = 0.5; }
        }
      });
      ctx.group.add(dimGroup);
      this._constraintObjects.set("__dim_preview__", dimGroup);
    }
  }

  /** previewConstraint → 임시 SketchConstraint 변환 */
  private _buildPreviewConstraint(
    ctx: OverlayRenderContext,
    preview: NonNullable<DimensionDrawTool["previewConstraint"]>,
  ): SketchConstraint | null {
    const { type, value, geomIds, vertexHandles } = preview;
    const id = "__dim_preview__";

    switch (type) {
      case "line_length":
        return geomIds[0] ? { type: "line_length", id, line: { geomId: geomIds[0] }, value } : null;
      case "distance":
        return vertexHandles.length >= 2 ? {
          type: "distance", id,
          pointA: { geomId: vertexHandles[0].geomId, vertexIndex: vertexHandles[0].vertexIndex },
          pointB: { geomId: vertexHandles[1].geomId, vertexIndex: vertexHandles[1].vertexIndex },
          value,
        } : null;
      case "radius":
        return geomIds[0] ? { type: "radius", id, circle: { geomId: geomIds[0] }, value } : null;
      case "diameter":
        return geomIds[0] ? { type: "diameter", id, circle: { geomId: geomIds[0] }, value } : null;
      case "angle":
        return geomIds.length >= 2 ? { type: "angle", id, lineA: { geomId: geomIds[0] }, lineB: { geomId: geomIds[1] }, value } : null;
      case "line_angle":
        return geomIds[0] ? { type: "line_angle", id, line: { geomId: geomIds[0] }, value } : null;
      case "horizontal_distance":
        return vertexHandles.length >= 2 ? {
          type: "horizontal_distance", id,
          pointA: { geomId: vertexHandles[0].geomId, vertexIndex: vertexHandles[0].vertexIndex },
          pointB: { geomId: vertexHandles[1].geomId, vertexIndex: vertexHandles[1].vertexIndex },
          value, sign: 1,
        } : null;
      case "vertical_distance":
        return vertexHandles.length >= 2 ? {
          type: "vertical_distance", id,
          pointA: { geomId: vertexHandles[0].geomId, vertexIndex: vertexHandles[0].vertexIndex },
          pointB: { geomId: vertexHandles[1].geomId, vertexIndex: vertexHandles[1].vertexIndex },
          value, sign: 1,
        } : null;
      case "point_line_distance": {
        const lineGid = geomIds.find((gid) => ctx.store?.geometries.get(gid)?.type === "line");
        if (!lineGid || vertexHandles.length < 1) return null;
        return {
          type: "point_line_distance", id,
          point: { geomId: vertexHandles[0].geomId, vertexIndex: vertexHandles[0].vertexIndex },
          line: { geomId: lineGid },
          value,
        };
      }
      case "line_line_distance": {
        const lineGids = geomIds.filter((gid) => ctx.store?.geometries.get(gid)?.type === "line");
        if (lineGids.length < 2) return null;
        return {
          type: "line_line_distance", id,
          lineA: { geomId: lineGids[0] },
          lineB: { geomId: lineGids[1] },
          value,
        };
      }
      case "point_circle_distance": {
        const circleGid = geomIds.find((gid) => {
          const t = ctx.store?.geometries.get(gid)?.type;
          return t === "circle" || t === "arc";
        });
        if (!circleGid) return null;
        let pointRef: { geomId: string; vertexIndex: number } | null = null;
        if (vertexHandles.length >= 1) {
          pointRef = { geomId: vertexHandles[0].geomId, vertexIndex: vertexHandles[0].vertexIndex };
        } else {
          const ptGid = geomIds.find((gid) => ctx.store?.geometries.get(gid)?.type === "point");
          if (ptGid) pointRef = { geomId: ptGid, vertexIndex: 0 };
        }
        return pointRef ? { type: "point_circle_distance", id, point: pointRef, circle: { geomId: circleGid }, value } : null;
      }
      case "line_circle_distance": {
        const lineGid = geomIds.find((gid) => ctx.store?.geometries.get(gid)?.type === "line");
        const circleGid = geomIds.find((gid) => {
          const t = ctx.store?.geometries.get(gid)?.type;
          return t === "circle" || t === "arc";
        });
        if (!lineGid || !circleGid) return null;
        return { type: "line_circle_distance", id, line: { geomId: lineGid }, circle: { geomId: circleGid }, value };
      }
      case "circle_circle_distance": {
        const circleGids = geomIds.filter((gid) => {
          const t = ctx.store?.geometries.get(gid)?.type;
          return t === "circle" || t === "arc";
        });
        if (circleGids.length < 2) return null;
        return {
          type: "circle_circle_distance", id,
          circleA: { geomId: circleGids[0] },
          circleB: { geomId: circleGids[1] },
          value,
        };
      }
      case "arc_length": {
        const arcGid = geomIds.find((gid) => ctx.store?.geometries.get(gid)?.type === "arc");
        if (!arcGid) return null;
        return { type: "arc_length", id, arc: { geomId: arcGid }, value };
      }
      case "ellipse_major_radius":
      case "ellipse_minor_radius": {
        const eGid = geomIds.find((gid) => ctx.store?.geometries.get(gid)?.type === "ellipse");
        if (!eGid) return null;
        return { type, id, ellipse: { geomId: eGid }, value };
      }
      case "curve_length": {
        const cvGid = geomIds.find((gid) => ctx.store?.geometries.get(gid)?.type === "curve");
        if (!cvGid) return null;
        return { type: "curve_length", id, curve: { geomId: cvGid }, value };
      }
    }
    return null;
  }

  clear(): void {
    this._constraintObjects.clear();
    this._constraintPositions.clear();
  }

  clearAll(ctx: OverlayRenderContext): void {
    this._clearConstraintObjects(ctx);
  }

  dispose(): void {
    // 서브 렌더러 자체 자원 없음
  }

  // --- 내부 메서드 ---

  /** 렌더링된 dimGroup에서 모든 Line의 2D segment를 추출 */
  private _extractSegmentsFromGroup(
    ctx: OverlayRenderContext,
    group: THREE.Group,
  ): { ax: number; ay: number; bx: number; by: number }[] {
    const segs: { ax: number; ay: number; bx: number; by: number }[] = [];
    if (!ctx.sketchPlane) return segs;
    const { origin, u, v } = ctx.sketchPlane;

    group.traverse((child) => {
      if (!(child instanceof THREE.Line)) return;
      const posAttr = child.geometry.getAttribute("position");
      if (!posAttr || posAttr.count < 2) return;

      for (let i = 0; i < posAttr.count - 1; i++) {
        // 3D → 2D 역변환 (sketch plane 투영)
        const p1x = posAttr.getX(i) - origin.x, p1y = posAttr.getY(i) - origin.y, p1z = posAttr.getZ(i) - origin.z;
        const ax = p1x * u.x + p1y * u.y + p1z * u.z;
        const ay = p1x * v.x + p1y * v.y + p1z * v.z;

        const p2x = posAttr.getX(i + 1) - origin.x, p2y = posAttr.getY(i + 1) - origin.y, p2z = posAttr.getZ(i + 1) - origin.z;
        const bx = p2x * u.x + p2y * u.y + p2z * u.z;
        const by = p2x * v.x + p2y * v.y + p2z * v.z;

        segs.push({ ax, ay, bx, by });
      }
    });
    return segs;
  }

  /** 치수 그룹을 씬에 추가하고 공통 속성 설정 */
  private _addDimensionObject(
    ctx: OverlayRenderContext, id: string, pos: { x: number; y: number },
    group: THREE.Group | null, highlight: boolean,
  ): boolean {
    if (!group) return false;
    group.name = `constraint-${id}`;
    if (highlight) this._tintGroupSelected(ctx, group);
    group.traverse((child) => { child.renderOrder = 997; });
    ctx.group.add(group);
    this._constraintObjects.set(id, group);
    this._constraintPositions.set(id, pos);
    return true;
  }

  /** 구속 타입에 맞는 치수선 그룹 생성 (디스패치) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _createDimensionGroupByType(ctx: OverlayRenderContext, c: SketchConstraint): THREE.Group | null {
    const geos: Map<string, SerializedGeometry> = ctx.store?.geometries ?? new Map();
    const lp = (lbl: SketchConstraint) => getEffectiveLabelPos(lbl, geos);
    switch (c.type) {
      case "line_length": return this._createLineLengthDimensionGroup(ctx, c);
      case "angle": return this._createAngleDimensionGroup(ctx, c);
      case "line_angle": return this._createLineAngleDimensionGroup(ctx, c);
      case "distance": return this._createTwoPointDimensionGroup(ctx, c.pointA, c.pointB, c.value, "free", lp(c));
      case "horizontal_distance": return this._createTwoPointDimensionGroup(ctx, c.pointA, c.pointB, c.value, "horizontal", lp(c));
      case "vertical_distance": return this._createTwoPointDimensionGroup(ctx, c.pointA, c.pointB, c.value, "vertical", lp(c));
      case "radius": return this._createRadiusDimensionGroup(ctx, c);
      case "diameter": return this._createDiameterDimensionGroup(ctx, c);
      case "point_line_distance": return this._createPointLineDimensionGroup(ctx, c);
      case "line_line_distance": return this._createLineLineDimensionGroup(ctx, c);
      case "point_circle_distance": return this._createPointCircleDimensionGroup(ctx, c);
      case "line_circle_distance": return this._createLineCircleDimensionGroup(ctx, c);
      case "circle_circle_distance": return this._createCircleCircleDimensionGroup(ctx, c);
      case "arc_length": return this._createArcLengthDimensionGroup(ctx, c);
      case "ellipse_major_radius":
      case "ellipse_minor_radius":
        return this._createEllipseRadiusDimensionGroup(ctx, c);
      case "curve_length": return this._createCurveLengthDimensionGroup(ctx, c);
      default: return null;
    }
  }

  private _clearConstraintObjects(ctx: OverlayRenderContext): void {
    for (const [, obj] of this._constraintObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._constraintObjects.clear();
    this._constraintPositions.clear();
    this._dimensionSegments.clear();
  }

  /** constraint가 참조하는 geometry ID 목록 */
  private _getConstraintGeomIds(c: SketchConstraint): string[] {
    const ids: string[] = [];
    if ("pointA" in c && c.pointA) ids.push((c.pointA as ConstraintPointRef).geomId);
    if ("pointB" in c && c.pointB) ids.push((c.pointB as ConstraintPointRef).geomId);
    if ("point" in c && c.point) ids.push((c.point as ConstraintPointRef).geomId);
    if ("line" in c && c.line) ids.push((c.line as ConstraintPointRef).geomId);
    if ("lineA" in c && c.lineA) ids.push((c.lineA as ConstraintPointRef).geomId);
    if ("lineB" in c && c.lineB) ids.push((c.lineB as ConstraintPointRef).geomId);
    if ("circle" in c && c.circle) ids.push((c.circle as ConstraintPointRef).geomId);
    return ids;
  }

  private _getConstraintPosition(ctx: OverlayRenderContext, c: SketchConstraint): { x: number; y: number } | null {
    switch (c.type) {
      case "coincident": {
        return this._getVertexCoord(ctx, c.pointA);
      }
      case "horizontal":
      case "vertical":
        return this._getLineMidpoint(ctx, c.line.geomId);
      case "horizontal_pp":
      case "vertical_pp": {
        const a = this._getVertexCoord(ctx, c.pointA);
        const b = this._getVertexCoord(ctx, c.pointB);
        return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
      }
      case "symmetric_point": {
        const a = this._getVertexCoord(ctx, c.pointA);
        const b = this._getVertexCoord(ctx, c.pointB);
        return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
      }
      case "fix":
        return this._getVertexCoord(ctx, c.point);
      case "distance": {
        const a = this._getVertexCoord(ctx, c.pointA);
        const b = this._getVertexCoord(ctx, c.pointB);
        if (!a || !b) return null;
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      case "horizontal_distance":
      case "vertical_distance": {
        const ha = this._getVertexCoord(ctx, c.pointA);
        const hb = this._getVertexCoord(ctx, c.pointB);
        if (!ha || !hb) return null;
        return { x: (ha.x + hb.x) / 2, y: (ha.y + hb.y) / 2 };
      }
      case "equal":
      case "colinear":
        return this._getLineMidpoint(ctx, c.lineA.geomId);
      case "parallel": {
        const pA = this._getLineMidpoint(ctx, c.lineA.geomId);
        const pB = this._getLineMidpoint(ctx, c.lineB.geomId);
        if (!pA || !pB) return pA ?? pB;
        return { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
      }
      case "perpendicular": {
        const gA = ctx.store?.geometries.get(c.lineA.geomId);
        const gB = ctx.store?.geometries.get(c.lineB.geomId);
        if (!gA || !gB || gA.type !== "line" || gB.type !== "line") return this._getLineMidpoint(ctx, c.lineA.geomId);
        const d1x = gA.x2 - gA.x1, d1y = gA.y2 - gA.y1;
        const d2x = gB.x2 - gB.x1, d2y = gB.y2 - gB.y1;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-9) return this._getLineMidpoint(ctx, c.lineA.geomId);
        const t = ((gB.x1 - gA.x1) * d2y - (gB.y1 - gA.y1) * d2x) / denom;
        return { x: gA.x1 + t * d1x, y: gA.y1 + t * d1y };
      }
      case "tangent": {
        const geomA = ctx.store?.geometries.get(c.entityA.geomId);
        const geomB = ctx.store?.geometries.get(c.entityB.geomId);
        if (!geomA || !geomB) return null;
        const line = geomA.type === "line" ? geomA : geomB.type === "line" ? geomB : null;
        const circ = geomA.type === "circle" || geomA.type === "arc" ? geomA
          : geomB.type === "circle" || geomB.type === "arc" ? geomB : null;
        if (line && circ) {
          const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 1e-12) return { x: line.x1, y: line.y1 };
          const t = ((circ.cx - line.x1) * dx + (circ.cy - line.y1) * dy) / lenSq;
          return { x: line.x1 + t * dx, y: line.y1 + t * dy };
        }
        const circA = (geomA.type === "circle" || geomA.type === "arc") ? geomA : null;
        const circB = (geomB.type === "circle" || geomB.type === "arc") ? geomB : null;
        if (circA && circB) {
          const dx = circB.cx - circA.cx, dy = circB.cy - circA.cy;
          const d = Math.hypot(dx, dy);
          if (d < 1e-9) return { x: circA.cx, y: circA.cy };
          return { x: circA.cx + (dx / d) * circA.r, y: circA.cy + (dy / d) * circA.r };
        }
        if (geomA.type === "line") return this._getLineMidpoint(ctx, c.entityA.geomId);
        return null;
      }
      case "point_on_circle":
        return this._getVertexCoord(ctx, c.point);
      case "radius":
      case "diameter": {
        const rGeom = ctx.store?.geometries.get(c.circle.geomId);
        if (!rGeom) return null;
        if (rGeom.type === "circle" || rGeom.type === "arc") {
          let rAngle = Math.PI / 4;
          if (rGeom.type === "arc") {
            const s = rGeom.startAngle; let e = rGeom.endAngle;
            while (e < s) e += Math.PI * 2;
            rAngle = (s + e) / 2;
          }
          return { x: rGeom.cx + (rGeom.r + ctx.worldPerPixel * 40) * Math.cos(rAngle), y: rGeom.cy + (rGeom.r + ctx.worldPerPixel * 40) * Math.sin(rAngle) };
        }
        return null;
      }
      case "equal_radius": {
        const erGeom = ctx.store?.geometries.get(c.circleA.geomId);
        if (!erGeom) return null;
        if (erGeom.type === "circle" || erGeom.type === "arc") return { x: erGeom.cx, y: erGeom.cy };
        return null;
      }
      case "point_on_line":
      case "midpoint":
        return this._getVertexCoord(ctx, c.point);
      case "concentric": {
        const geom = ctx.store?.geometries.get(c.circleA.geomId);
        if (!geom) return null;
        if (geom.type === "circle" || geom.type === "arc") return { x: geom.cx, y: geom.cy };
        return null;
      }
      case "line_length":
        return this._getLineMidpoint(ctx, c.line.geomId);
      case "line_angle":
        return this._getLineMidpoint(ctx, c.line.geomId);
      case "angle":
        return this._getLineMidpoint(ctx, c.lineA.geomId);
      case "point_line_distance":
        return this._getVertexCoord(ctx, c.point);
      case "line_line_distance":
        return this._getLineMidpoint(ctx, c.lineA.geomId);
      case "point_circle_distance":
        return this._getVertexCoord(ctx, c.point);
      case "line_circle_distance":
        return this._getLineMidpoint(ctx, c.line.geomId);
      case "circle_circle_distance": {
        const a = ctx.store?.geometries.get(c.circleA.geomId);
        const b = ctx.store?.geometries.get(c.circleB.geomId);
        if ((a?.type !== "circle" && a?.type !== "arc") || (b?.type !== "circle" && b?.type !== "arc")) return null;
        return { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 };
      }
      case "arc_length": {
        const arc = ctx.store?.geometries.get(c.arc.geomId);
        if (arc?.type !== "arc") return null;
        let sweep = arc.endAngle - arc.startAngle;
        if (sweep <= 0) sweep += Math.PI * 2;
        const mid = arc.startAngle + sweep / 2;
        return { x: arc.cx + Math.cos(mid) * arc.r, y: arc.cy + Math.sin(mid) * arc.r };
      }
      case "ellipse_major_radius":
      case "ellipse_minor_radius": {
        const e = ctx.store?.geometries.get(c.ellipse.geomId);
        if (e?.type !== "ellipse") return null;
        return { x: e.cx, y: e.cy };
      }
      case "curve_length": {
        const cv = ctx.store?.geometries.get(c.curve.geomId);
        if (cv?.type !== "curve" || cv.points.length === 0) return null;
        const mid = cv.points[Math.floor(cv.points.length / 2)];
        return { x: mid.x, y: mid.y };
      }
      case "symmetric": {
        const pA = this._getVertexCoord(ctx, c.pointA);
        const pB = this._getVertexCoord(ctx, c.pointB);
        if (!pA || !pB) return null;
        return { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
      }
      case "equidistant":
        return this._getVertexCoord(ctx, c.center);
      case "fix_together": {
        // 첫 번째 요소의 위치 사용
        const ftGeom = ctx.store?.geometries.get(c.elements[0]?.geomId);
        if (!ftGeom) return null;
        if (ftGeom.type === "line") return this._getLineMidpoint(ctx, ftGeom.id);
        if (ftGeom.type === "circle" || ftGeom.type === "arc") return { x: ftGeom.cx, y: ftGeom.cy };
        if (ftGeom.type === "point") return { x: ftGeom.x, y: ftGeom.y };
        return null;
      }
    }
  }

  private _getConstraintDisplayPosition(ctx: OverlayRenderContext, c: SketchConstraint, pos: { x: number; y: number }): { x: number; y: number } {
    const offset = ctx.worldPerPixel * 15;
    switch (c.type) {
      case "vertical":
      case "vertical_pp":
        return { x: pos.x + offset, y: pos.y };
      case "perpendicular":
        return pos;
      case "parallel":
        return pos;
      case "coincident":
        return pos; // 점 위치 그대로 (작은 dot 심볼)
      case "horizontal":
      case "horizontal_pp":
      case "symmetric_point":
      case "fix":
      case "equal":
      case "tangent":
      case "point_on_circle":
      case "equal_radius":
      case "point_on_line":
      case "midpoint":
      case "concentric":
      case "colinear":
        return { x: pos.x, y: pos.y + offset };
      default:
        return pos;
    }
  }

  private _createConstraintSymbols(ctx: OverlayRenderContext, c: SketchConstraint, pos: { x: number; y: number }, colorOverride?: number): THREE.Object3D[] {
    const offset = ctx.worldPerPixel * 15;
    const clr = colorOverride ?? COLOR_CONSTRAINT;
    switch (c.type) {
      case "coincident":
        return []; // CATIA 스타일: coincident는 점이 같은 위치에 있음으로 충분, 별도 심볼 불필요
      case "horizontal":
        return this._createHorizontalSymbol(ctx, c, pos, clr);
      case "vertical":
        return this._createVerticalSymbol(ctx, c, pos, clr);
      case "horizontal_pp":
        return [this._createConstraintSprite(ctx, "H", clr, pos.x, pos.y + offset)];
      case "vertical_pp":
        return [this._createConstraintSprite(ctx, "V", clr, pos.x + offset, pos.y)];
      case "symmetric_point":
        return [this._createConstraintSprite(ctx, "⇌", clr, pos.x, pos.y + offset)];
      case "fix":
        return this._createFixSymbol(ctx, pos, clr);
      case "distance":
      case "horizontal_distance":
      case "vertical_distance":
        return [];
      case "equal": {
        const posB = this._getLineMidpoint(ctx, c.lineB.geomId);
        const sprites = [this._createConstraintSprite(ctx, "=", clr, pos.x, pos.y + offset)];
        if (posB) sprites.push(this._createConstraintSprite(ctx, "=", clr, posB.x, posB.y + offset));
        return sprites;
      }
      case "parallel": {
        const midA = this._getLineMidpoint(ctx, c.lineA.geomId);
        const midB = this._getLineMidpoint(ctx, c.lineB.geomId);
        if (!midA || !midB) return [this._createConstraintIconSprite(ctx, c.type, pos.x, pos.y + offset, colorOverride)];
        const objects: THREE.Object3D[] = [];
        const connLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([ctx.toWorld(midA.x, midA.y), ctx.toWorld(midB.x, midB.y)]),
          new THREE.LineDashedMaterial({ color: clr, dashSize: 2, gapSize: 1, linewidth: 1, depthTest: false }),
        );
        connLine.computeLineDistances();
        objects.push(connLine);
        const cx = (midA.x + midB.x) / 2;
        const cy = (midA.y + midB.y) / 2;
        objects.push(this._createConstraintIconSprite(ctx, c.type, cx, cy, colorOverride));
        return objects;
      }
      case "perpendicular": {
        const gA = ctx.store?.geometries.get(c.lineA.geomId);
        const gB = ctx.store?.geometries.get(c.lineB.geomId);
        if (!gA || !gB || gA.type !== "line" || gB.type !== "line") {
          return [this._createConstraintIconSprite(ctx, c.type, pos.x, pos.y + offset, colorOverride)];
        }
        const objects: THREE.Object3D[] = [];
        const mat = new THREE.LineBasicMaterial({ color: clr, linewidth: 2, depthTest: false });
        const dashedMat = new THREE.LineDashedMaterial({ color: clr, dashSize: 2, gapSize: 1, linewidth: 1, depthTest: false });

        const d1x = gA.x2 - gA.x1, d1y = gA.y2 - gA.y1;
        const d2x = gB.x2 - gB.x1, d2y = gB.y2 - gB.y1;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-9) {
          return [this._createConstraintIconSprite(ctx, c.type, pos.x, pos.y + offset, colorOverride)];
        }
        const t = ((gB.x1 - gA.x1) * d2y - (gB.y1 - gA.y1) * d2x) / denom;
        const ix = gA.x1 + t * d1x;
        const iy = gA.y1 + t * d1y;

        const v = ((gB.x1 - gA.x1) * d1y - (gB.y1 - gA.y1) * d1x) / denom;
        if (t < 0 || t > 1) {
          const nearA = t < 0.5 ? { x: gA.x1, y: gA.y1 } : { x: gA.x2, y: gA.y2 };
          const extLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([ctx.toWorld(nearA.x, nearA.y), ctx.toWorld(ix, iy)]),
            dashedMat.clone(),
          );
          extLine.computeLineDistances();
          objects.push(extLine);
        }
        if (v < 0 || v > 1) {
          const nearB = v < 0.5 ? { x: gB.x1, y: gB.y1 } : { x: gB.x2, y: gB.y2 };
          const extLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([ctx.toWorld(nearB.x, nearB.y), ctx.toWorld(ix, iy)]),
            dashedMat.clone(),
          );
          extLine.computeLineDistances();
          objects.push(extLine);
        }

        // CATIA 식 무방향: mark 방향을 line direction (vertex 0→1 순서) 에 의존하지 않도록
        // 교차점에서 더 먼 endpoint 방향으로 normalize. 사용자가 line 을 어느 방향으로 그렸든
        // mark 가 같은 corner 에 표시됨.
        const markSize = ctx.worldPerPixel * 8;
        const distA1 = Math.hypot(gA.x1 - ix, gA.y1 - iy);
        const distA2 = Math.hypot(gA.x2 - ix, gA.y2 - iy);
        const farAx = distA1 >= distA2 ? gA.x1 : gA.x2;
        const farAy = distA1 >= distA2 ? gA.y1 : gA.y2;
        const farADx = farAx - ix, farADy = farAy - iy;
        const farALen = Math.hypot(farADx, farADy) || 1;
        const uAx = farADx / farALen, uAy = farADy / farALen;
        const distB1 = Math.hypot(gB.x1 - ix, gB.y1 - iy);
        const distB2 = Math.hypot(gB.x2 - ix, gB.y2 - iy);
        const farBx = distB1 >= distB2 ? gB.x1 : gB.x2;
        const farBy = distB1 >= distB2 ? gB.y1 : gB.y2;
        const farBDx = farBx - ix, farBDy = farBy - iy;
        const farBLen = Math.hypot(farBDx, farBDy) || 1;
        const uBx = farBDx / farBLen, uBy = farBDy / farBLen;
        const p1 = { x: ix + uAx * markSize, y: iy + uAy * markSize };
        const p2 = { x: ix + uAx * markSize + uBx * markSize, y: iy + uAy * markSize + uBy * markSize };
        const p3 = { x: ix + uBx * markSize, y: iy + uBy * markSize };
        const rightAngleLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            ctx.toWorld(p1.x, p1.y), ctx.toWorld(p2.x, p2.y), ctx.toWorld(p3.x, p3.y),
          ]),
          mat,
        );
        objects.push(rightAngleLine);
        return objects;
      }
      case "tangent":
        return [this._createConstraintIconSprite(ctx, c.type, pos.x, pos.y + offset, colorOverride)];
      case "point_on_circle":
        return this._createPointOnSymbol(ctx, pos, clr);
      case "radius":
      case "diameter":
        return [];
      case "equal_radius": {
        const erPosB = (() => {
          const g = ctx.store?.geometries.get(c.circleB.geomId);
          if (!g) return null;
          if (g.type === "circle" || g.type === "arc") return { x: g.cx, y: g.cy };
          return null;
        })();
        const erSprites = [this._createConstraintSprite(ctx, "R=", clr, pos.x, pos.y + offset)];
        if (erPosB) erSprites.push(this._createConstraintSprite(ctx, "R=", clr, erPosB.x, erPosB.y + offset));
        return erSprites;
      }
      case "point_on_line":
        return this._createPointOnSymbol(ctx, pos, clr);
      case "midpoint":
        return this._createMidpointSymbol(ctx, pos, clr);
      case "concentric":
        return this._createConcentricSymbol(ctx, pos, clr);
      case "colinear": {
        const posB = this._getLineMidpoint(ctx, c.lineB.geomId);
        const sprites = [this._createConstraintIconSprite(ctx, c.type, pos.x, pos.y + offset, colorOverride)];
        if (posB) sprites.push(this._createConstraintIconSprite(ctx, c.type, posB.x, posB.y + offset, colorOverride));
        return sprites;
      }
      case "line_length":
      case "line_angle":
      case "angle":
      case "point_line_distance":
      case "line_line_distance":
      case "point_circle_distance":
      case "line_circle_distance":
      case "circle_circle_distance":
      case "arc_length":
      case "ellipse_major_radius":
      case "ellipse_minor_radius":
      case "curve_length":
        return [];
      case "symmetric":
        return [this._createConstraintSprite(ctx, "⇌", clr, pos.x, pos.y + offset)];
      case "equidistant":
        return [this._createConstraintSprite(ctx, "⇔", clr, pos.x, pos.y + offset)];
      case "fix_together": {
        const label = c.label ? `⊕ ${c.label}` : "⊕";
        return [this._createConstraintSprite(ctx, label, clr, pos.x, pos.y + offset)];
      }
    }
  }

  // --- CATIA V5 스타일 기하 심볼 렌더링 ---

  /** Horizontal 구속: 선 중점 근처에 짧은 수평 바 + "H" 라벨 */
  private _createHorizontalSymbol(ctx: OverlayRenderContext, _c: Extract<SketchConstraint, { type: "horizontal" }>, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const offset = wpp * 15;

    // "H" 라벨만 표시
    const label = this._createConstraintSprite(ctx, "H", color, pos.x, pos.y + offset);

    return [label];
  }

  /** Vertical 구속: 선 중점 근처에 짧은 수직 바 + "V" 라벨 */
  private _createVerticalSymbol(ctx: OverlayRenderContext, _c: Extract<SketchConstraint, { type: "vertical" }>, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const offset = wpp * 15;

    // "V" 라벨만 표시
    const label = this._createConstraintSprite(ctx, "V", color, pos.x + offset, pos.y);

    return [label];
  }

  /** Coincident 구속: 작은 채워진 원 (3~4px, CATIA처럼 미묘한 표시) */
  private _createCoincidentSymbol(ctx: OverlayRenderContext, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const r = wpp * 3.5;
    const segments = 12;

    const geom = new THREE.CircleGeometry(1, segments);
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    const worldPos = ctx.toWorld(pos.x, pos.y);
    mesh.position.copy(worldPos);
    mesh.quaternion.copy(ctx.planeQuat);
    mesh.scale.set(r, r, 1);
    mesh.renderOrder = 997;

    return [mesh];
  }

  /** Fix 구속: 앵커 심볼 (십자 + 아래 삼각 받침) */
  private _createFixSymbol(ctx: OverlayRenderContext, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const offset = wpp * 15;
    const cx = pos.x;
    const cy = pos.y + offset;
    const s = wpp * 6; // 심볼 반 크기
    const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
    const objects: THREE.Object3D[] = [];

    // 수직선 (위로)
    const vertLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(cx, cy),
        ctx.toWorld(cx, cy + s * 1.5),
      ]),
      mat,
    );
    vertLine.renderOrder = 997;
    objects.push(vertLine);

    // 수평 바 (상단)
    const horizBar = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(cx - s, cy + s * 1.5),
        ctx.toWorld(cx + s, cy + s * 1.5),
      ]),
      mat.clone(),
    );
    horizBar.renderOrder = 997;
    objects.push(horizBar);

    // 해시선 3개 (고정 지면 표현 — CATIA 스타일 ground 심볼)
    const hashCount = 3;
    const hashLen = wpp * 3;
    const barW = s * 2;
    for (let i = 0; i < hashCount; i++) {
      const t = (i + 0.5) / hashCount;
      const hx = cx - s + t * barW;
      const hy = cy + s * 1.5;
      const hashLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(hx, hy),
          ctx.toWorld(hx - hashLen, hy + hashLen),
        ]),
        mat.clone(),
      );
      hashLine.renderOrder = 997;
      objects.push(hashLine);
    }

    return objects;
  }

  /** Midpoint 구속: 작은 다이아몬드(◇) */
  private _createMidpointSymbol(ctx: OverlayRenderContext, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const offset = wpp * 15;
    const cx = pos.x;
    const cy = pos.y + offset;
    const s = wpp * 5; // 다이아몬드 반 크기
    const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });

    // 다이아몬드 외곽선 (4점 → 닫힌 도형)
    const diamond = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(cx, cy + s),     // 상
        ctx.toWorld(cx + s, cy),     // 우
        ctx.toWorld(cx, cy - s),     // 하
        ctx.toWorld(cx - s, cy),     // 좌
        ctx.toWorld(cx, cy + s),     // 닫기
      ]),
      mat,
    );
    diamond.renderOrder = 997;

    return [diamond];
  }

  /** Concentric 구속: 불스아이 (이중 동심원) */
  private _createConcentricSymbol(ctx: OverlayRenderContext, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const offset = wpp * 15;
    const cx = pos.x;
    const cy = pos.y + offset;
    const r1 = wpp * 3;  // 내부 원
    const r2 = wpp * 6;  // 외부 원
    const segments = 24;
    const mat = new THREE.LineBasicMaterial({ color, linewidth: 1, depthTest: false });
    const objects: THREE.Object3D[] = [];

    // 내부 원
    const innerPts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      innerPts.push(ctx.toWorld(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1));
    }
    const innerCircle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(innerPts), mat);
    innerCircle.renderOrder = 997;
    objects.push(innerCircle);

    // 외부 원
    const outerPts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      outerPts.push(ctx.toWorld(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2));
    }
    const outerCircle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(outerPts), mat.clone());
    outerCircle.renderOrder = 997;
    objects.push(outerCircle);

    return objects;
  }

  /** Point on Line / Point on Circle 구속: 작은 × 마크 */
  private _createPointOnSymbol(ctx: OverlayRenderContext, pos: { x: number; y: number }, color: number): THREE.Object3D[] {
    const wpp = ctx.worldPerPixel;
    const offset = wpp * 15;
    const cx = pos.x;
    const cy = pos.y + offset;
    const s = wpp * 4; // × 반 크기
    const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });

    // 대각선 1 (\)
    const line1 = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(cx - s, cy + s),
        ctx.toWorld(cx + s, cy - s),
      ]),
      mat,
    );
    line1.renderOrder = 997;

    // 대각선 2 (/)
    const line2 = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(cx - s, cy - s),
        ctx.toWorld(cx + s, cy + s),
      ]),
      mat.clone(),
    );
    line2.renderOrder = 997;

    return [line1, line2];
  }

  private _constraintMatchesVertex(ctx: OverlayRenderContext, c: SketchConstraint, hv: { geomId: string; vertexIndex: number; x: number; y: number }): boolean {
    const EPS = 1e-4;
    const pointRefs: ConstraintPointRef[] = [];
    if (c.type === "coincident") {
      pointRefs.push(c.pointA, c.pointB);
    } else if (c.type === "point_on_line") {
      pointRefs.push(c.point);
    } else {
      return false;
    }
    for (const ref of pointRefs) {
      if (ref.geomId === hv.geomId && ref.vertexIndex === hv.vertexIndex) return true;
      const coord = this._getVertexCoord(ctx, ref);
      if (coord && Math.abs(coord.x - hv.x) < EPS && Math.abs(coord.y - hv.y) < EPS) return true;
    }
    return false;
  }

  private _getVertexCoord(ctx: OverlayRenderContext, ref: ConstraintPointRef): { x: number; y: number } | null {
    const geom = ctx.store?.geometries.get(ref.geomId);
    if (!geom) return null;
    switch (geom.type) {
      case "point":
        return { x: geom.x, y: geom.y };
      case "line":
        return ref.vertexIndex === 0 ? { x: geom.x1, y: geom.y1 } : { x: geom.x2, y: geom.y2 };
      case "circle":
        return { x: geom.cx, y: geom.cy };
      case "arc": {
        if (ref.vertexIndex === 0) return { x: geom.cx, y: geom.cy };
        if (ref.vertexIndex === 1) return { x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) };
        return { x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) };
      }
      case "curve":
        return ref.vertexIndex < geom.points.length ? geom.points[ref.vertexIndex] : null;
      default:
        return null;
    }
  }

  private _getLineMidpoint(ctx: OverlayRenderContext, geomId: string): { x: number; y: number } | null {
    const geom = ctx.store?.geometries.get(geomId);
    if (!geom || geom.type !== "line") return null;
    return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
  }

  private _createConstraintSprite(ctx: OverlayRenderContext, text: string, color: number, x: number, y: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const canvasCtx = canvas.getContext("2d")!;
    const font = "bold 14px monospace";
    canvasCtx.font = font;
    const textWidth = canvasCtx.measureText(text).width;
    const padding = 6;
    canvas.width = Math.ceil(textWidth) + padding * 2;
    canvas.height = 22;

    canvasCtx.fillStyle = "rgba(0, 0, 0, 0.6)";
    canvasCtx.roundRect(0, 0, canvas.width, canvas.height, 3);
    canvasCtx.fill();

    canvasCtx.font = font;
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    canvasCtx.fillStyle = `rgb(${r},${g},${b})`;
    canvasCtx.textAlign = "center";
    canvasCtx.textBaseline = "middle";
    canvasCtx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);

    const wpp = ctx.worldPerPixel;
    sprite.position.copy(ctx.toWorld(x, y));
    const aspect = canvas.width / canvas.height;
    const labelH = wpp * CONSTRAINT_LABEL_SCREEN_HEIGHT;
    sprite.scale.set(labelH * aspect, labelH, 1);
    sprite.renderOrder = 997;
    // _wrapLabelInParens 가 텍스트를 찾아 (...) 로 감쌀 수 있도록 보관
    sprite.userData.text = text;

    return sprite;
  }

  private _createConstraintIconSprite(ctx: OverlayRenderContext, constraintType: string, x: number, y: number, colorOverride?: number): THREE.Sprite {
    const icon = iconCache.get(constraintType);
    const size = CONSTRAINT_ICON_SIZE;
    const padding = 4;
    const canvasSize = size + padding * 2;

    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const canvasCtx = canvas.getContext("2d")!;

    canvasCtx.fillStyle = "rgba(0, 0, 0, 0.6)";
    canvasCtx.roundRect(0, 0, canvasSize, canvasSize, 4);
    canvasCtx.fill();

    if (icon) {
      canvasCtx.drawImage(icon, padding, padding, size, size);
      if (colorOverride !== undefined) {
        canvasCtx.globalCompositeOperation = "source-atop";
        const cr = (colorOverride >> 16) & 0xff;
        const cg = (colorOverride >> 8) & 0xff;
        const cb = colorOverride & 0xff;
        canvasCtx.fillStyle = `rgb(${cr},${cg},${cb})`;
        canvasCtx.fillRect(0, 0, canvasSize, canvasSize);
        canvasCtx.globalCompositeOperation = "source-over";
      }
    } else {
      const fallbackColor = colorOverride !== undefined
        ? `rgb(${(colorOverride >> 16) & 0xff},${(colorOverride >> 8) & 0xff},${colorOverride & 0xff})`
        : "#06b6d4";
      canvasCtx.font = "bold 14px monospace";
      canvasCtx.fillStyle = fallbackColor;
      canvasCtx.textAlign = "center";
      canvasCtx.textBaseline = "middle";
      canvasCtx.fillText(constraintType.charAt(0).toUpperCase(), canvasSize / 2, canvasSize / 2);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);

    const wpp = ctx.worldPerPixel;
    sprite.position.copy(ctx.toWorld(x, y));
    const labelH = wpp * CONSTRAINT_LABEL_SCREEN_HEIGHT;
    sprite.scale.set(labelH, labelH, 1);
    sprite.renderOrder = 997;

    return sprite;
  }

  private _tintGroupSelected(ctx: OverlayRenderContext, group: THREE.Object3D): void {
    const selColor = new THREE.Color(COLOR_SELECTED);
    // sprite 의 텍스처는 텍스트 색이 박혀있어 material.color tint (multiply) 로는 색 변경
    // 결과가 어둡게 곱해져 안 보임. sprite 자체를 SELECTED 색으로 다시 그려 swap.
    const spritesToSwap: THREE.Sprite[] = [];
    group.traverse((child) => {
      if (child instanceof THREE.Line) {
        (child.material as THREE.LineBasicMaterial).color.copy(selColor);
      } else if (child instanceof THREE.Sprite) {
        // 이미 selected 색으로 swap 된 sprite 는 재생성 skip — hover 빈도 높을 때 GPU 누수 방지.
        if (child.userData.isSelected) return;
        spritesToSwap.push(child);
      } else if (child instanceof THREE.Mesh) {
        (child.material as THREE.MeshBasicMaterial).color.copy(selColor);
      }
    });
    for (const sp of spritesToSwap) {
      const text = (sp.userData.text as string | undefined) ?? "";
      if (!text || !sp.parent) continue;
      const newSprite = this._createConstraintSprite(ctx, text, COLOR_SELECTED, 0, 0);
      newSprite.position.copy(sp.position);
      newSprite.userData.isSelected = true;
      sp.parent.add(newSprite);
      sp.parent.remove(sp);
      (sp.material as THREE.SpriteMaterial).map?.dispose();
      (sp.material as THREE.Material).dispose();
    }
  }

  // --- 참조 전용(driven) dimension helpers ---

  /** group 내 모든 Line / LineSegments / Mesh 의 material 색상을 일괄 변경 (driven 표시용). */
  private _recolorGroup(group: THREE.Object3D, color: number): void {
    group.traverse((obj) => {
      if ((obj as THREE.Sprite).isSprite) return; // sprite 는 별도 처리 (텍스처 색상)
      const m = (obj as THREE.Line | THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      for (const mat of mats) {
        if ("color" in mat && (mat as THREE.LineBasicMaterial).color) {
          (mat as THREE.LineBasicMaterial).color.setHex(color);
        }
      }
    });
  }

  /**
   * group 내 가장 큰 sprite (= 값 라벨) 를 찾아 텍스트를 (...) 로 감싸고 색상을 driven 으로 교체.
   * sprite 의 CanvasTexture 는 immutable 한 거나 다름없어 sprite 자체를 새로 생성해 swap.
   * 휴리스틱: sprite 의 scale.x (텍스트 폭) 가 가장 큰 것을 라벨로 간주.
   */
  private _wrapLabelInParens(ctx: OverlayRenderContext, group: THREE.Group): void {
    let label: THREE.Sprite | null = null;
    let maxScale = 0;
    group.traverse((obj) => {
      if (!(obj as THREE.Sprite).isSprite) return;
      const sp = obj as THREE.Sprite;
      if (sp.scale.x > maxScale) {
        maxScale = sp.scale.x;
        label = sp;
      }
    });
    if (!label) return;
    const lbl: THREE.Sprite = label;
    const oldText = (lbl.userData.text as string | undefined) ?? "";
    if (!oldText) return;
    const newText = `(${oldText})`;
    const newSprite = this._createConstraintSprite(ctx, newText, COLOR_DRIVEN_DIM, lbl.position.x, lbl.position.y);
    if (lbl.parent) {
      lbl.parent.add(newSprite);
      lbl.parent.remove(lbl);
    }
    (lbl.material as THREE.SpriteMaterial).map?.dispose();
    (lbl.material as THREE.Material).dispose();
  }

  // --- 치수 라벨 위치 ---

  private _getDimensionLabelPos(ctx: OverlayRenderContext, c: SketchConstraint): { x: number; y: number } | null {
    // labelOffset (상대) 우선, 없으면 labelPos (절대) — 기하 이동 시 라벨도 따라가도록.
    const eff = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    if (eff) return eff;

    const wpp = ctx.worldPerPixel;
    const offset = wpp * 30;
    switch (c.type) {
      case "line_length": {
        const g = ctx.store?.geometries.get(c.line.geomId);
        if (!g || g.type !== "line") return null;
        const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return null;
        const nx = -dy / len, ny = dx / len;
        return {
          x: (g.x1 + g.x2) / 2 + nx * offset,
          y: (g.y1 + g.y2) / 2 + ny * offset,
        };
      }
      case "distance": {
        const pA = this._getVertexCoord(ctx, c.pointA);
        const pB = this._getVertexCoord(ctx, c.pointB);
        if (!pA || !pB) return null;
        const dx = pB.x - pA.x, dy = pB.y - pA.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return null;
        const nx = -dy / len, ny = dx / len;
        return {
          x: (pA.x + pB.x) / 2 + nx * offset,
          y: (pA.y + pB.y) / 2 + ny * offset,
        };
      }
      case "horizontal_distance": {
        const hpA = this._getVertexCoord(ctx, c.pointA);
        const hpB = this._getVertexCoord(ctx, c.pointB);
        if (!hpA || !hpB) return null;
        return { x: (hpA.x + hpB.x) / 2, y: Math.max(hpA.y, hpB.y) + offset };
      }
      case "vertical_distance": {
        const vpA = this._getVertexCoord(ctx, c.pointA);
        const vpB = this._getVertexCoord(ctx, c.pointB);
        if (!vpA || !vpB) return null;
        return { x: Math.max(vpA.x, vpB.x) + offset, y: (vpA.y + vpB.y) / 2 };
      }
      case "radius":
      case "diameter": {
        const g = ctx.store?.geometries.get(c.circle.geomId);
        if (!g || (g.type !== "circle" && g.type !== "arc")) return null;
        const lp2 = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
        let rAngle: number;
        if (lp2) {
          rAngle = Math.atan2(lp2.y - g.cy, lp2.x - g.cx);
        } else if (g.type === "arc") {
          let e = g.endAngle;
          if (e <= g.startAngle) e += Math.PI * 2;
          rAngle = (g.startAngle + e) / 2;
        } else {
          rAngle = Math.PI / 4;
        }
        return {
          x: g.cx + (g.r + offset) * Math.cos(rAngle),
          y: g.cy + (g.r + offset) * Math.sin(rAngle),
        };
      }
      case "line_angle": {
        const laGeom = ctx.store?.geometries.get(c.line.geomId);
        if (!laGeom || laGeom.type !== "line") return null;
        const laMidX = (laGeom.x1 + laGeom.x2) / 2;
        const laMidY = (laGeom.y1 + laGeom.y2) / 2;
        return { x: laMidX, y: laMidY + offset };
      }
      case "angle": {
        const gA = ctx.store?.geometries.get(c.lineA.geomId);
        const gB = ctx.store?.geometries.get(c.lineB.geomId);
        if (!gA || !gB || gA.type !== "line" || gB.type !== "line") return null;
        const midA = { x: (gA.x1 + gA.x2) / 2, y: (gA.y1 + gA.y2) / 2 };
        const midB = { x: (gB.x1 + gB.x2) / 2, y: (gB.y1 + gB.y2) / 2 };
        return { x: (midA.x + midB.x) / 2, y: (midA.y + midB.y) / 2 + offset };
      }
      case "point_line_distance": {
        const pt = this._getVertexCoord(ctx, c.point);
        const lineGeom = ctx.store?.geometries.get(c.line.geomId);
        if (!pt || !lineGeom || lineGeom.type !== "line") return null;
        const ldx = lineGeom.x2 - lineGeom.x1, ldy = lineGeom.y2 - lineGeom.y1;
        const llen = Math.hypot(ldx, ldy);
        if (llen < 1e-6) return null;
        const t = ((pt.x - lineGeom.x1) * ldx + (pt.y - lineGeom.y1) * ldy) / (llen * llen);
        const foot = { x: lineGeom.x1 + t * ldx, y: lineGeom.y1 + t * ldy };
        // 라벨 위치: foot-point 중점에서 선 방향으로 오프셋
        const tx = ldx / llen, ty = ldy / llen;
        const midX = (pt.x + foot.x) / 2 + tx * offset;
        const midY = (pt.y + foot.y) / 2 + ty * offset;
        return { x: midX, y: midY };
      }
      case "line_line_distance": {
        const lA = ctx.store?.geometries.get(c.lineA.geomId);
        const lB = ctx.store?.geometries.get(c.lineB.geomId);
        if (lA?.type !== "line" || lB?.type !== "line") return null;
        const ldx = lB.x2 - lB.x1, ldy = lB.y2 - lB.y1;
        const llen = Math.hypot(ldx, ldy);
        if (llen < 1e-6) return null;
        const t = ((lA.x1 - lB.x1) * ldx + (lA.y1 - lB.y1) * ldy) / (llen * llen);
        const foot = { x: lB.x1 + t * ldx, y: lB.y1 + t * ldy };
        const tx = ldx / llen, ty = ldy / llen;
        const midX = (lA.x1 + foot.x) / 2 + tx * offset;
        const midY = (lA.y1 + foot.y) / 2 + ty * offset;
        return { x: midX, y: midY };
      }
      case "point_circle_distance": {
        const pt = this._getVertexCoord(ctx, c.point);
        const cir = ctx.store?.geometries.get(c.circle.geomId);
        if (!pt || (cir?.type !== "circle" && cir?.type !== "arc")) return null;
        // 점에서 center 방향으로 r 만큼 떨어진 둘레 위 점 + 점-둘레 중점
        const dx = cir.cx - pt.x, dy = cir.cy - pt.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) return null;
        const ux = dx / d, uy = dy / d;
        const periX = cir.cx - ux * cir.r, periY = cir.cy - uy * cir.r;
        return { x: (pt.x + periX) / 2 + offset, y: (pt.y + periY) / 2 };
      }
      case "line_circle_distance": {
        const ln = ctx.store?.geometries.get(c.line.geomId);
        const cir = ctx.store?.geometries.get(c.circle.geomId);
        if (ln?.type !== "line" || (cir?.type !== "circle" && cir?.type !== "arc")) return null;
        // line 중점 + 원 둘레의 line 쪽 점 사이 중점
        const lmid = { x: (ln.x1 + ln.x2) / 2, y: (ln.y1 + ln.y2) / 2 };
        return { x: (lmid.x + cir.cx) / 2, y: (lmid.y + cir.cy) / 2 + offset };
      }
      case "circle_circle_distance": {
        const a = ctx.store?.geometries.get(c.circleA.geomId);
        const b = ctx.store?.geometries.get(c.circleB.geomId);
        if ((a?.type !== "circle" && a?.type !== "arc") || (b?.type !== "circle" && b?.type !== "arc")) return null;
        return { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 + offset };
      }
      case "arc_length": {
        const arc = ctx.store?.geometries.get(c.arc.geomId);
        if (arc?.type !== "arc") return null;
        let sweep = arc.endAngle - arc.startAngle;
        if (sweep <= 0) sweep += Math.PI * 2;
        const mid = arc.startAngle + sweep / 2;
        return { x: arc.cx + Math.cos(mid) * (arc.r + offset), y: arc.cy + Math.sin(mid) * (arc.r + offset) };
      }
      case "ellipse_major_radius":
      case "ellipse_minor_radius": {
        const e = ctx.store?.geometries.get(c.ellipse.geomId);
        if (e?.type !== "ellipse") return null;
        const isMajor = c.type === "ellipse_major_radius";
        // major: rotation 방향, minor: rotation + 90°
        const ang = isMajor ? e.rotation : e.rotation + Math.PI / 2;
        const r = isMajor ? Math.max(e.rx, e.ry) : Math.min(e.rx, e.ry);
        return { x: e.cx + Math.cos(ang) * (r + offset), y: e.cy + Math.sin(ang) * (r + offset) };
      }
      case "curve_length": {
        const cv = ctx.store?.geometries.get(c.curve.geomId);
        if (cv?.type !== "curve" || cv.points.length === 0) return null;
        const mid = cv.points[Math.floor(cv.points.length / 2)];
        return { x: mid.x, y: mid.y + offset };
      }
    }
    return null;
  }

  // --- 치수선 그룹 생성 ---

  private _createLineLengthDimensionGroup(ctx: OverlayRenderContext, c: Extract<SketchConstraint, { type: "line_length" }>): THREE.Group | null {
    const geom = ctx.store?.geometries.get(c.line.geomId);
    if (!geom || geom.type !== "line") return null;

    const x1 = geom.x1, y1 = geom.y1, x2 = geom.x2, y2 = geom.y2;
    const wpp = ctx.worldPerPixel;

    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const nx = -dy / len, ny = dx / len;

    // labelPos가 있으면 기하 중점에서 법선 방향 투영으로 offset 계산
    const lp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const offset = lp ? ((lp.x - mx) * nx + (lp.y - my) * ny) : wpp * 30;

    const ox1 = x1 + nx * offset, oy1 = y1 + ny * offset;
    const ox2 = x2 + nx * offset, oy2 = y2 + ny * offset;

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });

    // extension line — line 끝점에서 offset 방향으로 멀어지며 dim line 까지. offset 부호 따라 방향 결정.
    const sign = offset >= 0 ? 1 : -1;
    const gap = wpp * 5 * sign;
    const extExtra = wpp * 5 * sign;
    const ext1Pts = [
      ctx.toWorld(x1 + nx * gap, y1 + ny * gap),
      ctx.toWorld(ox1 + nx * extExtra, oy1 + ny * extExtra),
    ];
    const ext2Pts = [
      ctx.toWorld(x2 + nx * gap, y2 + ny * gap),
      ctx.toWorld(ox2 + nx * extExtra, oy2 + ny * extExtra),
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ext1Pts), lineMat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ext2Pts), lineMat.clone()));

    const dimPts = [ctx.toWorld(ox1, oy1), ctx.toWorld(ox2, oy2)];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(dimPts), lineMat.clone()));

    const arrowSize = wpp * 6;
    const dirX = dx / len, dirY = dy / len;

    const a1Tip = ctx.toWorld(ox1, oy1);
    const a1L = ctx.toWorld(ox1 + dirX * arrowSize + nx * arrowSize * 0.4, oy1 + dirY * arrowSize + ny * arrowSize * 0.4);
    const a1R = ctx.toWorld(ox1 + dirX * arrowSize - nx * arrowSize * 0.4, oy1 + dirY * arrowSize - ny * arrowSize * 0.4);
    const arrow1Geom = new THREE.BufferGeometry().setFromPoints([a1Tip, a1L, a1R]);
    arrow1Geom.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(arrow1Geom, new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false })));

    const a2Tip = ctx.toWorld(ox2, oy2);
    const a2L = ctx.toWorld(ox2 - dirX * arrowSize + nx * arrowSize * 0.4, oy2 - dirY * arrowSize + ny * arrowSize * 0.4);
    const a2R = ctx.toWorld(ox2 - dirX * arrowSize - nx * arrowSize * 0.4, oy2 - dirY * arrowSize - ny * arrowSize * 0.4);
    const arrow2Geom = new THREE.BufferGeometry().setFromPoints([a2Tip, a2L, a2R]);
    arrow2Geom.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(arrow2Geom, new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false })));

    const labelX = ox1 + (ox2 - ox1) * 0.5;
    const labelY = oy1 + (oy2 - oy1) * 0.5;
    const label = this._createConstraintSprite(ctx, formatLengthDisplay(c.value, 2), COLOR_CONSTRAINT, labelX, labelY);
    group.add(label);

    return group;
  }

  private _createAngleDimensionGroup(ctx: OverlayRenderContext, c: Extract<SketchConstraint, { type: "angle" }>): THREE.Group | null {
    const geomA = ctx.store?.geometries.get(c.lineA.geomId);
    const geomB = ctx.store?.geometries.get(c.lineB.geomId);
    if (!geomA || geomA.type !== "line" || !geomB || geomB.type !== "line") return null;

    const wpp = ctx.worldPerPixel;
    const ax1 = geomA.x1, ay1 = geomA.y1, ax2 = geomA.x2, ay2 = geomA.y2;
    const bx1 = geomB.x1, by1 = geomB.y1, bx2 = geomB.x2, by2 = geomB.y2;

    // 두 직선의 교점
    const denom = (ax1 - ax2) * (by1 - by2) - (ay1 - ay2) * (bx1 - bx2);
    if (Math.abs(denom) < 1e-10) return null; // 평행
    const t = ((ax1 - bx1) * (by1 - by2) - (ay1 - by1) * (bx1 - bx2)) / denom;
    const cx = ax1 + t * (ax2 - ax1), cy = ay1 + t * (ay2 - ay1);

    // labelPos → 교점 기준 offset
    const lp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    const offX = lp ? lp.x - cx : wpp * 25;
    const offY = lp ? lp.y - cy : 0;
    const radius = Math.hypot(offX, offY);
    if (radius < 1e-6) return null;

    // 선 방향 벡터
    const dxA = ax2 - ax1, dyA = ay2 - ay1;
    const dxB = bx2 - bx1, dyB = by2 - by1;

    // Cross product로 마우스가 각 선의 어느 쪽인지 판별
    const sideA = dxA * offY - dyA * offX;
    const sideB = dxB * offY - dyB * offX;

    // 직선-원 교점 (각 선 2개씩, 총 4개)
    const lineCircleHits = (lx1: number, ly1: number, lx2: number, ly2: number) => {
      const ldx = lx2 - lx1, ldy = ly2 - ly1;
      const a = ldx * ldx + ldy * ldy;
      const b = 2 * (ldx * (lx1 - cx) + ldy * (ly1 - cy));
      const det = b * b - 4 * a * ((lx1 - cx) ** 2 + (ly1 - cy) ** 2 - radius * radius);
      if (det < 0) return null;
      const sq = Math.sqrt(det);
      const t1 = (-b + sq) / (2 * a), t2 = (-b - sq) / (2 * a);
      const p1 = { x: lx1 + t1 * ldx, y: ly1 + t1 * ldy, onSeg: t1 >= 0 && t1 <= 1, t: t1 };
      const p2 = { x: lx1 + t2 * ldx, y: ly1 + t2 * ldy, onSeg: t2 >= 0 && t2 <= 1, t: t2 };
      // 선분에서 가장 가까운 점 (보조선 시작점)
      const clamp = (tv: number) => Math.max(0, Math.min(1, tv));
      p1.t = clamp(t1); p2.t = clamp(t2);
      return [p1, p2];
    };

    const hitsA = lineCircleHits(ax1, ay1, ax2, ay2);
    const hitsB = lineCircleHits(bx1, by1, bx2, by2);
    if (!hitsA || !hitsB) return null;

    // 마우스 측에 맞는 교점 선택 (cross product 부호 매칭)
    const pickHit = (hits: typeof hitsA, otherDx: number, otherDy: number, otherSide: number) => {
      const side0 = otherDx * (hits![0].y - cy) - otherDy * (hits![0].x - cx);
      return (otherSide >= 0 && side0 >= 0) || (otherSide < 0 && side0 < 0) ? hits![0] : hits![1];
    };
    const da = pickHit(hitsA, dxB, dyB, sideB);
    const db = pickHit(hitsB, dxA, dyA, sideA);

    // 호 방향: da → db 의 signed angle (라벨 영역의 자연 호)
    const vBetween = (ux: number, uy: number, vx: number, vy: number) =>
      Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const dxDA = da.x - cx, dyDA = da.y - cy;
    const dxDB = db.x - cx, dyDB = db.y - cy;
    const diff = vBetween(dxDA, dyDA, dxDB, dyDB);
    const angDA = Math.atan2(dyDA, dxDA);

    // 라벨 텍스트 = c.value (DimensionDrawTool 의 _maybeResolveAngleVariant 가 라벨 영역 기반
    // 사잇각/보각으로 자동 갱신해 둠 → panel 표시값과 일치 보장).
    const displayAngle = c.value;

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });
    const extOff = wpp * 8;

    // 보조선: 교점이 선분 바깥이면 가까운 끝점에서 호 교점까지
    const drawExt = (hit: typeof da, lx1: number, ly1: number, lx2: number, ly2: number) => {
      if (hit.onSeg) return;
      // 선분 위의 가장 가까운 점
      const ct = Math.max(0, Math.min(1, hit.t));
      const ldx = lx2 - lx1, ldy = ly2 - ly1;
      const segPt = { x: lx1 + ct * ldx, y: ly1 + ct * ldy };
      // 호 교점에서 선분 끝점 방향으로 offset
      const edx = segPt.x - hit.x, edy = segPt.y - hit.y;
      const elen = Math.hypot(edx, edy);
      if (elen < 1e-6) return;
      const enx = edx / elen, eny = edy / elen;
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(hit.x - enx * extOff, hit.y - eny * extOff),
          ctx.toWorld(segPt.x, segPt.y),
        ]),
        lineMat.clone(),
      ));
    };
    drawExt(da, ax1, ay1, ax2, ay2);
    drawExt(db, bx1, by1, bx2, by2);

    // 호 (치수선)
    const absSweep = Math.abs(diff);
    const arcSegs = Math.max(8, Math.ceil(absSweep / (Math.PI * 2) * 48));
    const arcPts: THREE.Vector3[] = [];
    for (let i = 0; i <= arcSegs; i++) {
      const a = angDA + (i / arcSegs) * diff;
      arcPts.push(ctx.toWorld(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), lineMat.clone()));

    // 화살표 (호 양 끝, 접선 방향)
    const arrowSize = wpp * 5;
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false });
    // 화살표 방향: 마우스와 같은 쪽
    const lDA = Math.hypot(dxDA, dyDA) || 1, lDB = Math.hypot(dxDB, dyDB) || 1;
    const vDA = [dxDA / lDA, dyDA / lDA], vDB = [dxDB / lDB, dyDB / lDB];
    const signA = vDA[0] * offY - vDA[1] * offX < 0 ? -1 : 1;
    const signB = vDB[0] * offY - vDB[1] * offX < 0 ? -1 : 1;
    const addArrow = (tipX: number, tipY: number, nx: number, ny: number, s: number) => {
      const tanX = -ny * s, tanY = nx * s;
      const p1 = ctx.toWorld(tipX, tipY);
      const p2 = ctx.toWorld(tipX + tanX * arrowSize + nx * arrowSize * 0.4, tipY + tanY * arrowSize + ny * arrowSize * 0.4);
      const p3 = ctx.toWorld(tipX + tanX * arrowSize - nx * arrowSize * 0.4, tipY + tanY * arrowSize - ny * arrowSize * 0.4);
      const g = new THREE.BufferGeometry().setFromPoints([p1, p2, p3]);
      g.setIndex([0, 1, 2]);
      group.add(new THREE.Mesh(g, arrowMat.clone()));
    };
    addArrow(da.x, da.y, vDA[0], vDA[1], signA);
    addArrow(db.x, db.y, vDB[0], vDB[1], signB);

    // 라벨: 라벨 영역 기반 표시 각도 (위에서 계산한 displayAngle).
    const labelX = lp ? lp.x : cx + Math.cos(angDA + diff / 2) * radius * 1.15;
    const labelY = lp ? lp.y : cy + Math.sin(angDA + diff / 2) * radius * 1.15;
    group.add(this._createConstraintSprite(ctx, `${displayAngle.toFixed(1)}°`, COLOR_CONSTRAINT, labelX, labelY));

    return group;
  }

  private _createLineAngleDimensionGroup(ctx: OverlayRenderContext, c: Extract<SketchConstraint, { type: "line_angle" }>): THREE.Group | null {
    const geom = ctx.store?.geometries.get(c.line.geomId);
    if (!geom || geom.type !== "line") return null;

    const wpp = ctx.worldPerPixel;
    // 선의 시작점을 기준으로 수평축과의 각도 표시
    const ox = geom.x1, oy = geom.y1;

    const laLp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    const radius = laLp ? Math.hypot(laLp.x - ox, laLp.y - oy) : wpp * 25;

    // c.value (degree, -180 ~ 360) 기반 호 sweep. line direction 의 자연 atan2 가 default.
    // 음수면 시계방향 호. 절대값이 0 이면 호 없음.
    const valueRad = c.value * Math.PI / 180;
    const actualStart = valueRad >= 0 ? 0 : valueRad;
    const actualSweep = Math.abs(valueRad);
    if (actualSweep < 1e-6) return null;

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });
    const extGap = wpp * 6;
    const extOver = wpp * 8;
    const arcEnd = radius + extOver;

    // 수평 참조선 (점선 스타일 — gap 띄우고 시작)
    const dashMat = new THREE.LineDashedMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false, dashSize: wpp * 4, gapSize: wpp * 3 });
    const refPts = [
      ctx.toWorld(ox + extGap, oy),
      ctx.toWorld(ox + arcEnd, oy),
    ];
    const refLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(refPts), dashMat);
    refLine.computeLineDistances();
    group.add(refLine);

    // 선 방향 보조선: 먼 끝점이 호보다 안쪽이면 보조선, 바깥이면 생략
    // line direction 은 c.value (signed, 라디안). 호의 끝점 위치.
    const lineDirAngle = valueRad;
    const farEnd = { x: geom.x2, y: geom.y2 };
    const farDist = Math.hypot(farEnd.x - ox, farEnd.y - oy);
    if (farDist < arcEnd) {
      const startDist = farDist + extGap;
      if (startDist < arcEnd) {
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            ctx.toWorld(ox + Math.cos(lineDirAngle) * startDist, oy + Math.sin(lineDirAngle) * startDist),
            ctx.toWorld(ox + Math.cos(lineDirAngle) * arcEnd, oy + Math.sin(lineDirAngle) * arcEnd),
          ]),
          lineMat,
        ));
      }
    }

    // 호 (치수선)
    const arcSegments = Math.max(8, Math.ceil(actualSweep / (Math.PI * 2) * 48));
    const arcPts: THREE.Vector3[] = [];
    for (let i = 0; i <= arcSegments; i++) {
      const a = actualStart + (i / arcSegments) * actualSweep;
      arcPts.push(ctx.toWorld(ox + Math.cos(a) * radius, oy + Math.sin(a) * radius));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), lineMat.clone()));

    // 화살표 (호의 양 끝)
    const arrowSize = wpp * 5;
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false });
    const addArrow = (angle: number, inward: boolean) => {
      const tipX = ox + Math.cos(angle) * radius;
      const tipY = oy + Math.sin(angle) * radius;
      const sign = inward ? 1 : -1;
      const tanX = -Math.sin(angle) * sign;
      const tanY = Math.cos(angle) * sign;
      const nrmX = Math.cos(angle);
      const nrmY = Math.sin(angle);
      const p1 = ctx.toWorld(tipX, tipY);
      const p2 = ctx.toWorld(tipX + tanX * arrowSize + nrmX * arrowSize * 0.4, tipY + tanY * arrowSize + nrmY * arrowSize * 0.4);
      const p3 = ctx.toWorld(tipX + tanX * arrowSize - nrmX * arrowSize * 0.4, tipY + tanY * arrowSize - nrmY * arrowSize * 0.4);
      const ag = new THREE.BufferGeometry().setFromPoints([p1, p2, p3]);
      ag.setIndex([0, 1, 2]);
      group.add(new THREE.Mesh(ag, arrowMat.clone()));
    };
    addArrow(actualStart, true);
    addArrow(actualStart + actualSweep, false);

    // 라벨: labelPos 위치에 직접 표시
    const labelX = laLp ? laLp.x : ox + Math.cos(actualStart + actualSweep / 2) * radius * 1.15;
    const labelY = laLp ? laLp.y : oy + Math.sin(actualStart + actualSweep / 2) * radius * 1.15;
    group.add(this._createConstraintSprite(ctx, `${c.value.toFixed(1)}°`, COLOR_CONSTRAINT, labelX, labelY));

    return group;
  }

  /** 두 점 사이 치수선 생성 (distance/h_distance/v_distance 공통) */
  private _createTwoPointDimensionGroup(
    ctx: OverlayRenderContext,
    pointA: ConstraintPointRef, pointB: ConstraintPointRef,
    value: number, mode: "free" | "horizontal" | "vertical",
    labelPos?: { x: number; y: number },
  ): THREE.Group | null {
    const a = this._getVertexCoord(ctx, pointA);
    const b = this._getVertexCoord(ctx, pointB);
    if (!a || !b) return null;
    const wpp = ctx.worldPerPixel;

    // 측정 방향(dir)과 법선 방향(norm), 치수선 양 끝점(d1, d2)
    let d1x: number, d1y: number, d2x: number, d2y: number;
    let dirX: number, dirY: number, normX: number, normY: number;

    if (mode === "free") {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return null;
      dirX = dx / len; dirY = dy / len;
      normX = -dirY; normY = dirX;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const off = labelPos ? ((labelPos.x - mx) * normX + (labelPos.y - my) * normY) : wpp * 30;
      d1x = a.x + normX * off; d1y = a.y + normY * off;
      d2x = b.x + normX * off; d2y = b.y + normY * off;
    } else if (mode === "horizontal") {
      dirX = 1; dirY = 0; normX = 0; normY = 1;
      if (Math.abs(b.x - a.x) < 1e-6) return null;
      const off = labelPos ? (labelPos.y - Math.max(a.y, b.y)) : wpp * 30;
      const dimY = Math.max(a.y, b.y) + off;
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      d1x = left; d1y = dimY; d2x = right; d2y = dimY;
    } else {
      dirX = 0; dirY = 1; normX = 1; normY = 0;
      if (Math.abs(b.y - a.y) < 1e-6) return null;
      const off = labelPos ? (labelPos.x - Math.max(a.x, b.x)) : wpp * 30;
      const dimX = Math.max(a.x, b.x) + off;
      const bot = Math.min(a.y, b.y), top = Math.max(a.y, b.y);
      d1x = dimX; d1y = bot; d2x = dimX; d2y = top;
    }

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });
    const extGap = wpp * 5, extOver = wpp * 5;

    // 보조선 (각 점에서 치수선까지, 법선 방향)
    if (mode === "free") {
      // free: a/b에서 법선 방향으로 치수선(d1/d2)까지
      const offSign = ((d1x - a.x) * normX + (d1y - a.y) * normY) >= 0 ? 1 : -1;
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(a.x + normX * extGap * offSign, a.y + normY * extGap * offSign),
        ctx.toWorld(d1x + normX * extOver * offSign, d1y + normY * extOver * offSign),
      ]), lineMat));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(b.x + normX * extGap * offSign, b.y + normY * extGap * offSign),
        ctx.toWorld(d2x + normX * extOver * offSign, d2y + normY * extOver * offSign),
      ]), lineMat.clone()));
    } else {
      // horizontal/vertical: 각 점의 측정축 좌표 유지, 법선 방향으로 치수선 높이까지
      const offA = (d1x - a.x) * normX + (d1y - a.y) * normY; // a→치수선까지 법선 방향 거리
      const offB = (d2x - b.x) * normX + (d2y - b.y) * normY;
      const sA = offA >= 0 ? 1 : -1, sB = offB >= 0 ? 1 : -1;
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(a.x + normX * extGap * sA, a.y + normY * extGap * sA),
        ctx.toWorld(a.x + normX * (offA + extOver * sA), a.y + normY * (offA + extOver * sA)),
      ]), lineMat));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(b.x + normX * extGap * sB, b.y + normY * extGap * sB),
        ctx.toWorld(b.x + normX * (offB + extOver * sB), b.y + normY * (offB + extOver * sB)),
      ]), lineMat.clone()));
    }

    // 치수선
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      ctx.toWorld(d1x, d1y), ctx.toWorld(d2x, d2y),
    ]), lineMat.clone()));

    // 화살표
    const as = wpp * 6;
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false });
    const addArrow = (tx: number, ty: number, sx: number) => {
      const p1 = ctx.toWorld(tx, ty);
      const p2 = ctx.toWorld(tx + dirX * as * sx + normX * as * 0.4, ty + dirY * as * sx + normY * as * 0.4);
      const p3 = ctx.toWorld(tx + dirX * as * sx - normX * as * 0.4, ty + dirY * as * sx - normY * as * 0.4);
      const g = new THREE.BufferGeometry().setFromPoints([p1, p2, p3]);
      g.setIndex([0, 1, 2]);
      group.add(new THREE.Mesh(g, arrowMat.clone()));
    };
    addArrow(d1x, d1y, 1);
    addArrow(d2x, d2y, -1);

    // 라벨
    group.add(this._createConstraintSprite(ctx, formatLengthDisplay(value, 2), COLOR_CONSTRAINT,
      (d1x + d2x) / 2, (d1y + d2y) / 2));
    return group;
  }


  private _createRadiusDimensionGroup(ctx: OverlayRenderContext, c: Extract<SketchConstraint, { type: "radius" }>): THREE.Group | null {
    const geom = ctx.store?.geometries.get(c.circle.geomId);
    if (!geom) return null;
    if (geom.type !== "circle" && geom.type !== "arc") return null;

    const cx = geom.cx, cy = geom.cy, r = geom.r;
    const wpp = ctx.worldPerPixel;

    // 라벨 방향 결정 (원 중심 기준 각도). labelPos 없으면 default 45°.
    const rLp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    let leaderAngle: number;
    let lpDist: number;
    if (rLp) {
      leaderAngle = Math.atan2(rLp.y - cy, rLp.x - cx);
      lpDist = Math.hypot(rLp.x - cx, rLp.y - cy);
    } else if (geom.type === "arc") {
      const s = geom.startAngle; let e = geom.endAngle;
      while (e < s) e += Math.PI * 2;
      leaderAngle = (s + e) / 2;
      lpDist = r + wpp * 40;
    } else {
      leaderAngle = Math.PI / 4;
      lpDist = r + wpp * 40;
    }
    const dirCos = Math.cos(leaderAngle), dirSin = Math.sin(leaderAngle);
    const edgeX = cx + r * dirCos, edgeY = cy + r * dirSin;
    const isInside = lpDist < r;

    // CATIA 식:
    // - 라벨 밖: leader = edge → labelPos. 화살표는 edge 에서 안쪽 (원 중심) 가리킴.
    // - 라벨 안: leader = labelPos → edge. 화살표는 edge 에서 바깥 가리킴.
    const labelX = rLp ? rLp.x : cx + (r + wpp * 40) * dirCos;
    const labelY = rLp ? rLp.y : cy + (r + wpp * 40) * dirSin;

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });

    // leader 라인 (라벨 ↔ edge)
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([ctx.toWorld(edgeX, edgeY), ctx.toWorld(labelX, labelY)]),
      lineMat,
    ));

    // 화살표
    const arrowSize = wpp * 6;
    // 화살표 방향: 라벨 안이면 edge → 바깥 (dir 방향). 라벨 밖이면 edge → 안 (-dir 방향).
    const arrowDirX = isInside ? dirCos : -dirCos;
    const arrowDirY = isInside ? dirSin : -dirSin;
    const nrmX = -arrowDirY, nrmY = arrowDirX;
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false });
    const aTip = ctx.toWorld(edgeX, edgeY);
    const aL = ctx.toWorld(edgeX + arrowDirX * arrowSize + nrmX * arrowSize * 0.4, edgeY + arrowDirY * arrowSize + nrmY * arrowSize * 0.4);
    const aR = ctx.toWorld(edgeX + arrowDirX * arrowSize - nrmX * arrowSize * 0.4, edgeY + arrowDirY * arrowSize - nrmY * arrowSize * 0.4);
    const arrowGeom = new THREE.BufferGeometry().setFromPoints([aTip, aL, aR]);
    arrowGeom.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(arrowGeom, arrowMat));

    group.add(this._createConstraintSprite(ctx, `R${formatLengthDisplay(c.value, 2)}`, COLOR_CONSTRAINT, labelX, labelY));

    return group;
  }

  private _createDiameterDimensionGroup(ctx: OverlayRenderContext, c: Extract<SketchConstraint, { type: "diameter" }>): THREE.Group | null {
    const geom = ctx.store?.geometries.get(c.circle.geomId);
    if (!geom) return null;
    if (geom.type !== "circle" && geom.type !== "arc") return null;

    const cx = geom.cx, cy = geom.cy, r = geom.r;
    const wpp = ctx.worldPerPixel;

    // 라벨 방향 결정 (원 중심 기준). labelPos 없으면 default 45°.
    const diaLp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    let leaderAngle: number;
    if (diaLp) {
      leaderAngle = Math.atan2(diaLp.y - cy, diaLp.x - cx);
    } else if (geom.type === "arc") {
      const s = geom.startAngle; let e = geom.endAngle;
      while (e < s) e += Math.PI * 2;
      leaderAngle = (s + e) / 2;
    } else {
      leaderAngle = Math.PI / 4;
    }
    const dirCos = Math.cos(leaderAngle), dirSin = Math.sin(leaderAngle);

    // dim line = 원을 가로지르는 지름선 (라벨 방향에 정렬). 양 끝 = 두 edge 점.
    const edgeFarX = cx + r * dirCos, edgeFarY = cy + r * dirSin;     // 라벨 쪽 edge
    const edgeNearX = cx - r * dirCos, edgeNearY = cy - r * dirSin;   // 반대편 edge

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });

    // 지름선
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(edgeNearX, edgeNearY), ctx.toWorld(edgeFarX, edgeFarY),
      ]),
      lineMat,
    ));

    // 양 끝 화살표 — 지름선 양쪽으로 (안쪽 가리킴)
    const arrowSize = wpp * 6;
    const nrmX = -dirSin, nrmY = dirCos;
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false });

    // edgeFar 화살표 (안쪽 향함, dir 의 반대)
    const a1Tip = ctx.toWorld(edgeFarX, edgeFarY);
    const a1L = ctx.toWorld(edgeFarX - dirCos * arrowSize + nrmX * arrowSize * 0.4, edgeFarY - dirSin * arrowSize + nrmY * arrowSize * 0.4);
    const a1R = ctx.toWorld(edgeFarX - dirCos * arrowSize - nrmX * arrowSize * 0.4, edgeFarY - dirSin * arrowSize - nrmY * arrowSize * 0.4);
    const arrow1 = new THREE.BufferGeometry().setFromPoints([a1Tip, a1L, a1R]);
    arrow1.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(arrow1, arrowMat));

    // edgeNear 화살표 (안쪽 향함, dir 방향)
    const a2Tip = ctx.toWorld(edgeNearX, edgeNearY);
    const a2L = ctx.toWorld(edgeNearX + dirCos * arrowSize + nrmX * arrowSize * 0.4, edgeNearY + dirSin * arrowSize + nrmY * arrowSize * 0.4);
    const a2R = ctx.toWorld(edgeNearX + dirCos * arrowSize - nrmX * arrowSize * 0.4, edgeNearY + dirSin * arrowSize - nrmY * arrowSize * 0.4);
    const arrow2 = new THREE.BufferGeometry().setFromPoints([a2Tip, a2L, a2R]);
    arrow2.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(arrow2, arrowMat.clone()));

    // 라벨: labelPos 있으면 거기, 없으면 지름선 중심 위쪽 약간
    let labelX: number, labelY: number;
    if (diaLp) {
      labelX = diaLp.x; labelY = diaLp.y;
      // labelPos 가 원 밖이면 leader (edgeFar → labelPos) 추가
      const lpDist = Math.hypot(labelX - cx, labelY - cy);
      if (lpDist > r) {
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            ctx.toWorld(edgeFarX, edgeFarY), ctx.toWorld(labelX, labelY),
          ]),
          lineMat.clone(),
        ));
      }
    } else {
      labelX = cx + nrmX * wpp * 12;
      labelY = cy + nrmY * wpp * 12;
    }
    group.add(this._createConstraintSprite(ctx, `⌀${formatLengthDisplay(c.value, 2)}`, COLOR_CONSTRAINT, labelX, labelY));

    return group;
  }

  private _createPointLineDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "point_line_distance" }>,
    options?: { lineLineMode?: boolean },
  ): THREE.Group | null {
    const ptCoord = this._getVertexCoord(ctx, c.point);
    const lineGeom = ctx.store?.geometries.get(c.line.geomId);
    if (!ptCoord || !lineGeom || lineGeom.type !== "line") return null;
    // 선-선 distance 가 _createLineLineDimensionGroup 에서 변환된 케이스만 line1 자체 방향
    // 보조선 처리. 진짜 점-선 dimension 은 c.point 가 line endpoint vertex 라도 점-선 처리.
    const pointGeomRaw = options?.lineLineMode ? ctx.store?.geometries.get(c.point.geomId) : null;
    const pointLineGeom = pointGeomRaw?.type === "line" ? pointGeomRaw : null;

    const px = ptCoord.x, py = ptCoord.y;
    const ax2 = lineGeom.x1, ay2 = lineGeom.y1, bx2 = lineGeom.x2, by2 = lineGeom.y2;
    const ab2x = bx2 - ax2, ab2y = by2 - ay2;
    const ab2Len2 = ab2x * ab2x + ab2y * ab2y;
    if (ab2Len2 < 1e-12) return null;
    const ab2Len = Math.sqrt(ab2Len2);
    const tx2 = ab2x / ab2Len, ty2 = ab2y / ab2Len;

    // P 의 line2 위 perp 투영 (거리 산출 + default labelPos 폴백용)
    const tFoot = ((px - ax2) * ab2x + (py - ay2) * ab2y) / ab2Len2;
    const fx = ax2 + tFoot * ab2x, fy = ay2 + tFoot * ab2y;
    const dist = Math.hypot(px - fx, py - fy);
    if (dist < 1e-6) return null;

    const wpp = ctx.worldPerPixel;
    const plLp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    // labelPos 없으면 foot 와 P 의 중점에서 line2 방향으로 30px 떨어진 위치 추정
    const lpx = plLp ? plLp.x : (fx + px) / 2 + tx2 * wpp * 30;
    const lpy = plLp ? plLp.y : (fy + py) / 2 + ty2 * wpp * 30;

    // dp1 = labelPos 의 line2 위 perp 투영
    const tLabel2 = ((lpx - ax2) * ab2x + (lpy - ay2) * ab2y) / ab2Len2;
    const dp1x = ax2 + tLabel2 * ab2x;
    const dp1y = ay2 + tLabel2 * ab2y;

    // dp2:
    // - 선-선: labelPos 의 line1 위 perp 투영 (line1 자기 방향 사용)
    // - 점-선: dp1 + (P - foot)  → labelPos perp 직선 위, line2 와 perp 거리만큼 떨어진 점
    let dp2x: number, dp2y: number;
    let pointLineParams: {
      ax1: number; ay1: number; bx1: number; by1: number;
      ab1x: number; ab1y: number; ab1Len2: number; tx1: number; ty1: number; tLabel1: number;
    } | null = null;
    if (pointLineGeom) {
      const ax1 = pointLineGeom.x1, ay1 = pointLineGeom.y1;
      const bx1 = pointLineGeom.x2, by1 = pointLineGeom.y2;
      const ab1x = bx1 - ax1, ab1y = by1 - ay1;
      const ab1Len2 = ab1x * ab1x + ab1y * ab1y;
      if (ab1Len2 < 1e-12) return null;
      const ab1Len = Math.sqrt(ab1Len2);
      const tLabel1 = ((lpx - ax1) * ab1x + (lpy - ay1) * ab1y) / ab1Len2;
      dp2x = ax1 + tLabel1 * ab1x;
      dp2y = ay1 + tLabel1 * ab1y;
      pointLineParams = {
        ax1, ay1, bx1, by1, ab1x, ab1y, ab1Len2,
        tx1: ab1x / ab1Len, ty1: ab1y / ab1Len, tLabel1,
      };
    } else {
      dp2x = dp1x + (px - fx);
      dp2y = dp1y + (py - fy);
    }

    const dimVecX = dp2x - dp1x, dimVecY = dp2y - dp1y;
    const dimLen = Math.hypot(dimVecX, dimVecY);
    if (dimLen < 1e-6) return null;
    const ddirX = dimVecX / dimLen, ddirY = dimVecY / dimLen;

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });
    const extOvershoot = wpp * 8;
    const extGap = wpp * 6;

    // line2 보조선: tLabel2 가 끝점밖이면 nearest endpoint 에서 dp1 까지, line2 자기 방향
    if (tLabel2 < 0 || tLabel2 > 1) {
      const nearX = tLabel2 < 0 ? ax2 : bx2;
      const nearY = tLabel2 < 0 ? ay2 : by2;
      const sign2 = (dp1x - nearX) * tx2 + (dp1y - nearY) * ty2 >= 0 ? 1 : -1;
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(nearX + tx2 * sign2 * extGap, nearY + ty2 * sign2 * extGap),
          ctx.toWorld(dp1x + tx2 * sign2 * extOvershoot, dp1y + ty2 * sign2 * extOvershoot),
        ]),
        lineMat,
      ));
    }
    // point/line1 보조선
    if (pointLineParams) {
      const { ax1, ay1, bx1, by1, tx1, ty1, tLabel1 } = pointLineParams;
      // 선-선: tLabel1 이 끝점밖이면 nearest endpoint → dp2, line1 자기 방향
      if (tLabel1 < 0 || tLabel1 > 1) {
        const nearX = tLabel1 < 0 ? ax1 : bx1;
        const nearY = tLabel1 < 0 ? ay1 : by1;
        const sign1 = (dp2x - nearX) * tx1 + (dp2y - nearY) * ty1 >= 0 ? 1 : -1;
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            ctx.toWorld(nearX + tx1 * sign1 * extGap, nearY + ty1 * sign1 * extGap),
            ctx.toWorld(dp2x + tx1 * sign1 * extOvershoot, dp2y + ty1 * sign1 * extOvershoot),
          ]),
          lineMat.clone(),
        ));
      }
    } else {
      // 점-선: 점에서 dp2 까지. 방향은 (dp2 - P) 이며 line2 방향과 평행 (점-선 perpendicular 거리 정의상)
      const dpdx = dp2x - px, dpdy = dp2y - py;
      const dpdLen = Math.hypot(dpdx, dpdy);
      if (dpdLen > 1e-9) {
        const eDirX = dpdx / dpdLen, eDirY = dpdy / dpdLen;
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            ctx.toWorld(px + eDirX * extGap, py + eDirY * extGap),
            ctx.toWorld(dp2x + eDirX * extOvershoot, dp2y + eDirY * extOvershoot),
          ]),
          lineMat.clone(),
        ));
      }
    }

    // Dim line
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([ctx.toWorld(dp1x, dp1y), ctx.toWorld(dp2x, dp2y)]),
      lineMat.clone(),
    ));

    // 화살표 (dim line 방향)
    const arrowSize = wpp * 6;
    const fnrmX = -ddirY, fnrmY = ddirX;
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLOR_CONSTRAINT, side: THREE.DoubleSide, depthTest: false });

    const a1Tip = ctx.toWorld(dp1x, dp1y);
    const a1L = ctx.toWorld(dp1x + ddirX * arrowSize + fnrmX * arrowSize * 0.4, dp1y + ddirY * arrowSize + fnrmY * arrowSize * 0.4);
    const a1R = ctx.toWorld(dp1x + ddirX * arrowSize - fnrmX * arrowSize * 0.4, dp1y + ddirY * arrowSize - fnrmY * arrowSize * 0.4);
    const a1Geom = new THREE.BufferGeometry().setFromPoints([a1Tip, a1L, a1R]);
    a1Geom.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(a1Geom, arrowMat));

    const a2Tip = ctx.toWorld(dp2x, dp2y);
    const a2L = ctx.toWorld(dp2x - ddirX * arrowSize + fnrmX * arrowSize * 0.4, dp2y - ddirY * arrowSize + fnrmY * arrowSize * 0.4);
    const a2R = ctx.toWorld(dp2x - ddirX * arrowSize - fnrmX * arrowSize * 0.4, dp2y - ddirY * arrowSize - fnrmY * arrowSize * 0.4);
    const a2Geom = new THREE.BufferGeometry().setFromPoints([a2Tip, a2L, a2R]);
    a2Geom.setIndex([0, 1, 2]);
    group.add(new THREE.Mesh(a2Geom, arrowMat.clone()));

    group.add(this._createConstraintSprite(ctx, formatLengthDisplay(c.value, 2), COLOR_CONSTRAINT,
      (dp1x + dp2x) / 2, (dp1y + dp2y) / 2));

    return group;
  }

  /**
   * Line–Line distance — _createPointLineDimensionGroup 이 이미 lineA.x1/y1 같은 line endpoint 를
   * point 로 받는 분기를 가지고 있어 그대로 재활용.
   */
  private _createLineLineDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "line_line_distance" }>,
  ): THREE.Group | null {
    // point_line_distance 형태로 변환: point = lineA 의 vertex 0 (=x1, y1).
    const synthesized: Extract<SketchConstraint, { type: "point_line_distance" }> = {
      type: "point_line_distance",
      id: c.id,
      point: { geomId: c.lineA.geomId, vertexIndex: 0 },
      line: { geomId: c.lineB.geomId },
      value: c.value,
      isReference: c.isReference,
      isInternal: c.isInternal,
      labelPos: c.labelPos,
      labelOffset: c.labelOffset,
      convertedByEE: c.convertedByEE,
    };
    return this._createPointLineDimensionGroup(ctx, synthesized, { lineLineMode: true });
  }

  /**
   * 두 점 사이 leader line + 라벨 — point/circle, line/circle 등 거리 dim 의 공통 helper.
   */
  private _createSimpleLeaderDimGroup(
    ctx: OverlayRenderContext,
    c: SketchConstraint,
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    valueText: string,
  ): THREE.Group {
    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });
    const lp = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    const lpx = lp ? lp.x : (p1.x + p2.x) / 2;
    const lpy = lp ? lp.y : (p1.y + p2.y) / 2;

    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(p1.x, p1.y),
        ctx.toWorld(p2.x, p2.y),
      ]),
      lineMat,
    ));
    group.add(this._createConstraintSprite(ctx, valueText, COLOR_CONSTRAINT, lpx, lpy));
    return group;
  }

  /**
   * Point–Circle distance — 점에서 원 둘레 가장 가까운 점까지 leader line + 거리 라벨.
   */
  private _createPointCircleDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "point_circle_distance" }>,
  ): THREE.Group | null {
    const pt = this._getVertexCoord(ctx, c.point);
    const cir = ctx.store?.geometries.get(c.circle.geomId);
    if (!pt || (cir?.type !== "circle" && cir?.type !== "arc")) return null;
    const dx = cir.cx - pt.x, dy = cir.cy - pt.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    const ux = dx / d, uy = dy / d;
    // 외부 점 가정 — 둘레 위 가장 가까운 점은 center 에서 반대 방향 r 만큼
    const periX = cir.cx - ux * cir.r;
    const periY = cir.cy - uy * cir.r;
    return this._createSimpleLeaderDimGroup(ctx, c, pt, { x: periX, y: periY }, formatLengthDisplay(c.value, 2));
  }

  /**
   * Line–Circle distance — line 중점에서 원 center 방향 둘레 점까지 leader line + 거리 라벨.
   */
  private _createLineCircleDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "line_circle_distance" }>,
  ): THREE.Group | null {
    const ln = ctx.store?.geometries.get(c.line.geomId);
    const cir = ctx.store?.geometries.get(c.circle.geomId);
    if (ln?.type !== "line" || (cir?.type !== "circle" && cir?.type !== "arc")) return null;
    // line 위에서 center 의 perpendicular foot
    const ldx = ln.x2 - ln.x1, ldy = ln.y2 - ln.y1;
    const llen2 = ldx * ldx + ldy * ldy;
    if (llen2 < 1e-12) return null;
    const t = ((cir.cx - ln.x1) * ldx + (cir.cy - ln.y1) * ldy) / llen2;
    const foot = { x: ln.x1 + t * ldx, y: ln.y1 + t * ldy };
    // foot → center 방향, 둘레 점
    const fdx = cir.cx - foot.x, fdy = cir.cy - foot.y;
    const fd = Math.hypot(fdx, fdy);
    if (fd < 1e-6) return null;
    const ux = fdx / fd, uy = fdy / fd;
    const periX = cir.cx - ux * cir.r, periY = cir.cy - uy * cir.r;
    return this._createSimpleLeaderDimGroup(ctx, c, foot, { x: periX, y: periY }, formatLengthDisplay(c.value, 2));
  }

  /**
   * Circle–Circle distance — 두 center 잇는 직선 위 둘레 점들 사이 leader line + 거리 라벨.
   */
  private _createCircleCircleDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "circle_circle_distance" }>,
  ): THREE.Group | null {
    const a = ctx.store?.geometries.get(c.circleA.geomId);
    const b = ctx.store?.geometries.get(c.circleB.geomId);
    if ((a?.type !== "circle" && a?.type !== "arc") || (b?.type !== "circle" && b?.type !== "arc")) return null;
    const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    const ux = dx / d, uy = dy / d;
    const aPeri = { x: a.cx + ux * a.r, y: a.cy + uy * a.r };
    const bPeri = { x: b.cx - ux * b.r, y: b.cy - uy * b.r };
    return this._createSimpleLeaderDimGroup(ctx, c, aPeri, bPeri, formatLengthDisplay(c.value, 2));
  }

  /**
   * Arc length — arc 의 호 길이 (sweep × radius). center 에서 호 중간점까지 leader line +
   * 호 길이 라벨.
   */
  private _createArcLengthDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "arc_length" }>,
  ): THREE.Group | null {
    const arc = ctx.store?.geometries.get(c.arc.geomId);
    if (!arc || arc.type !== "arc") return null;

    let sweep = arc.endAngle - arc.startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    const midAngle = arc.startAngle + sweep / 2;

    const wpp = ctx.worldPerPixel;
    const labelPos = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    const offsetR = arc.r + wpp * 30;
    const lpx = labelPos ? labelPos.x : arc.cx + Math.cos(midAngle) * offsetR;
    const lpy = labelPos ? labelPos.y : arc.cy + Math.sin(midAngle) * offsetR;

    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR_CONSTRAINT, linewidth: 1, depthTest: false });

    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(arc.cx, arc.cy),
        ctx.toWorld(lpx, lpy),
      ]),
      lineMat,
    ));

    const midX = arc.cx + Math.cos(midAngle) * arc.r;
    const midY = arc.cy + Math.sin(midAngle) * arc.r;
    const tickLen = wpp * 4;
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        ctx.toWorld(midX - Math.cos(midAngle) * tickLen, midY - Math.sin(midAngle) * tickLen),
        ctx.toWorld(midX + Math.cos(midAngle) * tickLen, midY + Math.sin(midAngle) * tickLen),
      ]),
      lineMat.clone(),
    ));

    group.add(this._createConstraintSprite(ctx, formatLengthDisplay(c.value, 2), COLOR_CONSTRAINT, lpx, lpy));
    return group;
  }

  /**
   * Ellipse semi-major / semi-minor axis — center 에서 axis 방향 둘레까지 leader line + 라벨.
   */
  private _createEllipseRadiusDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "ellipse_major_radius" | "ellipse_minor_radius" }>,
  ): THREE.Group | null {
    const e = ctx.store?.geometries.get(c.ellipse.geomId);
    if (!e || e.type !== "ellipse") return null;
    const isMajor = c.type === "ellipse_major_radius";
    const r = isMajor ? Math.max(e.rx, e.ry) : Math.min(e.rx, e.ry);
    const ang = isMajor ? e.rotation : e.rotation + Math.PI / 2;
    const tip = { x: e.cx + Math.cos(ang) * r, y: e.cy + Math.sin(ang) * r };
    return this._createSimpleLeaderDimGroup(ctx, c, { x: e.cx, y: e.cy }, tip, formatLengthDisplay(c.value, 2));
  }

  /**
   * Curve length — control polygon 중간점에 라벨.
   */
  private _createCurveLengthDimensionGroup(
    ctx: OverlayRenderContext,
    c: Extract<SketchConstraint, { type: "curve_length" }>,
  ): THREE.Group | null {
    const cv = ctx.store?.geometries.get(c.curve.geomId);
    if (!cv || cv.type !== "curve" || cv.points.length === 0) return null;
    const labelPos = getEffectiveLabelPos(c, ctx.store?.geometries ?? new Map());
    const mid = cv.points[Math.floor(cv.points.length / 2)];
    const lpx = labelPos ? labelPos.x : mid.x;
    const lpy = labelPos ? labelPos.y : mid.y;

    const group = new THREE.Group();
    group.add(this._createConstraintSprite(ctx, formatLengthDisplay(c.value, 2), COLOR_CONSTRAINT, lpx, lpy));
    return group;
  }
}
