// vertex 핸들 및 박스 선택 시각화 렌더링

import * as THREE from "three";

import {
  COLOR_GEOMETRY,
  COLOR_HOVERED,
  COLOR_SELECTED,
  HANDLE_SCREEN_PX,
  POINT_RADIUS,
} from "./overlayConstants";
import type { OverlayRenderContext, OverlaySubRenderer } from "./OverlayRenderContext";

export class SelectionRenderer implements OverlaySubRenderer {
  private _vertexHandles: THREE.Mesh[] = [];
  private _selectionBoxObject: THREE.Object3D | null = null;

  sync(ctx: OverlayRenderContext): void {
    if (!ctx.store || !ctx.sketchPlane) return;

    this._updateVertexHandles(ctx);
    this._updateSelectionBox(ctx);
  }

  clear(): void {
    this._vertexHandles = [];
    this._selectionBoxObject = null;
  }

  clearAll(ctx: OverlayRenderContext): void {
    for (const mesh of this._vertexHandles) {
      ctx.group.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    this._vertexHandles = [];

    if (this._selectionBoxObject) {
      ctx.group.remove(this._selectionBoxObject);
      ctx.disposeObject(this._selectionBoxObject);
      this._selectionBoxObject = null;
    }
  }

  dispose(): void {
    // no-op — vertex handles는 sync 때마다 재생성/해제
  }

  // --- private ---

  private _updateVertexHandles(ctx: OverlayRenderContext): void {
    for (const mesh of this._vertexHandles) {
      ctx.group.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    this._vertexHandles = [];

    if (!ctx.store || !ctx.sketchPlane) return;

    const store = ctx.store;
    const h = store.hoveredItem;
    const hoveredVertex = h?.kind === "vertex" ? { geomId: h.geomId, vertexIndex: h.vertexIndex } : null;
    const selectedVerts = store.selectedVertices;

    const selectedVertexKeys = new Set(selectedVerts.map((v) => `${v.geomId}:${v.vertexIndex}`));

    const handleScale = ctx.worldPerPixel * HANDLE_SCREEN_PX / POINT_RADIUS;

    const vertexEntries: { h: { x: number; y: number; geomId: string; vertexIndex: number }; color: number; scale: number }[] = [];

    // coincident로 연결된 vertex 수집 (자유 vertex 판별용)
    const connectedVertexKeys = new Set<string>();
    if (ctx.constraintStore) {
      for (const c of ctx.constraintStore.constraints.values()) {
        if (c.type === "coincident") {
          connectedVertexKeys.add(`${c.pointA.geomId}:${c.pointA.vertexIndex}`);
          connectedVertexKeys.add(`${c.pointB.geomId}:${c.pointB.vertexIndex}`);
        } else if (c.type === "point_on_line" || c.type === "point_on_circle" || c.type === "midpoint" || c.type === "fix") {
          connectedVertexKeys.add(`${c.point.geomId}:${c.point.vertexIndex}`);
        }
      }
    }

    const hoveredKey = hoveredVertex ? `${hoveredVertex.geomId}:${hoveredVertex.vertexIndex}` : null;
    const selectedGeomSet = new Set(store.selectedIds);

    for (const [id, geom] of store.geometries) {
      const isRef = "isReference" in geom && geom.isReference;
      // 참조 기하: 선택/호버된 vertex만 표시
      if (isRef) {
        // 참조 축선 (type:"axis") 은 vertex 자체 없음 — extractVertices 가 빈 배열 반환.
        if (geom.type === "axis") continue;
        const handles = store.getVertexHandles(id);
        for (const h of handles) {
          const vKey = `${h.geomId}:${h.vertexIndex}`;
          const isHovered = hoveredKey === vKey;
          const isSelected = selectedVertexKeys.has(vKey);
          if (isHovered || isSelected) {
            const color = isSelected ? COLOR_SELECTED : COLOR_HOVERED;
            vertexEntries.push({ h, color, scale: handleScale });
          }
        }
        continue;
      }
      if (geom.type === "point") continue;

      const isGeomSelected = selectedGeomSet.has(id);
      const handles = store.getVertexHandles(id);
      for (const h of handles) {
        const vKey = `${h.geomId}:${h.vertexIndex}`;
        const isCenter = (geom.type === "circle" || geom.type === "arc") && h.vertexIndex === 0;
        const isFree = !connectedVertexKeys.has(vKey);
        const isHovered = hoveredKey === vKey;
        const isVtxSelected = selectedVertexKeys.has(vKey);

        // 선택된 기하의 vertex는 항상 표시 (CATIA 스타일 — 드래그 가능 핸들)
        if (!isGeomSelected && !isCenter && !isFree && !isHovered && !isVtxSelected) continue;

        let color = COLOR_GEOMETRY;
        if (isVtxSelected) color = COLOR_SELECTED;
        else if (isHovered) color = COLOR_HOVERED;

        vertexEntries.push({ h, color, scale: handleScale });
      }
    }

    for (const entry of vertexEntries) {
      const { h, color, scale } = entry;
      const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false });
      const mesh = new THREE.Mesh(ctx.circleGeom, material);
      mesh.position.copy(ctx.toWorld(h.x, h.y));
      mesh.quaternion.copy(ctx.planeQuat);
      mesh.scale.setScalar(scale);
      mesh.renderOrder = 998;
      mesh.name = `vertex-handle-${h.geomId}-${h.vertexIndex}`;
      ctx.group.add(mesh);
      this._vertexHandles.push(mesh);
    }
  }

  private _updateSelectionBox(ctx: OverlayRenderContext): void {
    if (this._selectionBoxObject) {
      ctx.group.remove(this._selectionBoxObject);
      ctx.disposeObject(this._selectionBoxObject);
      this._selectionBoxObject = null;
    }

    if (!ctx.selectionBoxStart || !ctx.selectionBoxEnd || !ctx.sketchPlane) return;

    const s = ctx.selectionBoxStart;
    const e = ctx.selectionBoxEnd;
    const isWindow = e.x >= s.x;

    const color = isWindow ? 0x2563eb : 0x22c55e;
    const group = new THREE.Group();
    group.renderOrder = 999;

    const corners = [
      ctx.toWorld(s.x, s.y),
      ctx.toWorld(e.x, s.y),
      ctx.toWorld(e.x, e.y),
      ctx.toWorld(s.x, e.y),
    ];
    const linePositions = new Float32Array([
      corners[0].x, corners[0].y, corners[0].z, corners[1].x, corners[1].y, corners[1].z,
      corners[1].x, corners[1].y, corners[1].z, corners[2].x, corners[2].y, corners[2].z,
      corners[2].x, corners[2].y, corners[2].z, corners[3].x, corners[3].y, corners[3].z,
      corners[3].x, corners[3].y, corners[3].z, corners[0].x, corners[0].y, corners[0].z,
    ]);
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
    let lineObj: THREE.Object3D;
    if (isWindow) {
      const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false });
      lineObj = new THREE.LineSegments(lineGeom, lineMat);
    } else {
      const dashMat = new THREE.LineDashedMaterial({
        color, depthTest: false,
        dashSize: ctx.worldPerPixel * 6,
        gapSize: ctx.worldPerPixel * 4,
      });
      const dashLine = new THREE.Line(lineGeom, dashMat);
      dashLine.computeLineDistances();
      lineObj = dashLine;
    }
    lineObj.renderOrder = 999;
    group.add(lineObj);

    const shape = new THREE.Shape();
    shape.moveTo(s.x, s.y);
    shape.lineTo(e.x, s.y);
    shape.lineTo(e.x, e.y);
    shape.lineTo(s.x, e.y);
    shape.closePath();

    const shapeGeom = new THREE.ShapeGeometry(shape);
    const posAttr = shapeGeom.getAttribute("position");
    for (let i = 0; i < posAttr.count; i++) {
      const lx = posAttr.getX(i);
      const ly = posAttr.getY(i);
      const wp = ctx.toWorld(lx, ly);
      posAttr.setXYZ(i, wp.x, wp.y, wp.z);
    }
    posAttr.needsUpdate = true;

    const fillMat = new THREE.MeshBasicMaterial({
      color,
      opacity: 0.08,
      transparent: true,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const fillMesh = new THREE.Mesh(shapeGeom, fillMat);
    fillMesh.renderOrder = 999;
    group.add(fillMesh);

    this._selectionBoxObject = group;
    ctx.group.add(group);
  }
}
