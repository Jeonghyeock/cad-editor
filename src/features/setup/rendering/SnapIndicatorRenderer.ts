// 스냅 인디케이터, 좌표 라벨, crosshair 렌더링

import * as THREE from "three";

import type { SnapResult } from "../sketch/SnapEngine";

import {
  COLOR_CROSSHAIR,
  COLOR_SNAP,
  CROSSHAIR_SCREEN_PX,
  SNAP_SCREEN_PX,
} from "./overlayConstants";
import type { OverlayRenderContext, OverlaySubRenderer } from "./OverlayRenderContext";

export class SnapIndicatorRenderer implements OverlaySubRenderer {
  private _snapIndicator: THREE.Object3D | null = null;
  private _snapCoordLabel: THREE.Sprite | null = null;
  private _crosshairObject: THREE.Object3D | null = null;

  sync(ctx: OverlayRenderContext): void {
    if (!ctx.sketchPlane) return;

    this._updateSnapIndicator(ctx);
    this._updateCrosshair(ctx);
  }

  clear(): void {
    this._snapIndicator = null;
    this._snapCoordLabel = null;
    this._crosshairObject = null;
  }

  clearAll(ctx: OverlayRenderContext): void {
    if (this._snapIndicator) {
      ctx.group.remove(this._snapIndicator);
      ctx.disposeObject(this._snapIndicator);
      this._snapIndicator = null;
    }

    if (this._snapCoordLabel) {
      ctx.group.remove(this._snapCoordLabel);
      this._snapCoordLabel.material.map?.dispose();
      this._snapCoordLabel.material.dispose();
      this._snapCoordLabel = null;
    }

    if (this._crosshairObject) {
      ctx.group.remove(this._crosshairObject);
      ctx.disposeObject(this._crosshairObject);
      this._crosshairObject = null;
    }
  }

  dispose(): void {
    // 서브 렌더러 자체 자원 없음
  }

  // --- private ---

  private _updateSnapIndicator(ctx: OverlayRenderContext): void {
    if (this._snapIndicator) {
      ctx.group.remove(this._snapIndicator);
      ctx.disposeObject(this._snapIndicator);
      this._snapIndicator = null;
    }
    if (this._snapCoordLabel) {
      ctx.group.remove(this._snapCoordLabel);
      this._snapCoordLabel.material.map?.dispose();
      this._snapCoordLabel.material.dispose();
      this._snapCoordLabel = null;
    }

    const snap = ctx.store?.snapResult;
    if (!snap || !ctx.sketchPlane) return;

    const s = ctx.worldPerPixel * SNAP_SCREEN_PX;
    let indicator: THREE.Object3D | null = null;

    switch (snap.type) {
      case "grid": {
        const group = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false });
        const g1 = new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(snap.x - s, snap.y), ctx.toWorld(snap.x + s, snap.y),
        ]);
        const g2 = new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(snap.x, snap.y - s), ctx.toWorld(snap.x, snap.y + s),
        ]);
        group.add(new THREE.Line(g1, mat));
        group.add(new THREE.Line(g2, mat.clone()));
        indicator = group;
        break;
      }
      case "endpoint": {
        const pts = [
          ctx.toWorld(snap.x - s, snap.y - s),
          ctx.toWorld(snap.x + s, snap.y - s),
          ctx.toWorld(snap.x + s, snap.y + s),
          ctx.toWorld(snap.x - s, snap.y + s),
          ctx.toWorld(snap.x - s, snap.y - s),
        ];
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        indicator = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false }));
        break;
      }
      case "midpoint": {
        const side = s * 2;
        const h = side * Math.sqrt(3) / 2;
        const pts = [
          ctx.toWorld(snap.x, snap.y + h * 2 / 3),
          ctx.toWorld(snap.x + side / 2, snap.y - h / 3),
          ctx.toWorld(snap.x - side / 2, snap.y - h / 3),
          ctx.toWorld(snap.x, snap.y + h * 2 / 3),
        ];
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        indicator = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false }));
        break;
      }
      case "center": {
        indicator = this._createCenterIndicator(ctx, snap, s);
        break;
      }
      case "origin": {
        const group = new THREE.Group();
        const solidMat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false });

        const segments = 24;
        const circlePts: THREE.Vector3[] = [];
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          circlePts.push(ctx.toWorld(snap.x + Math.cos(angle) * s, snap.y + Math.sin(angle) * s));
        }
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts), solidMat));

        const thickMat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 3, depthTest: false });
        const hPts = [ctx.toWorld(snap.x - s, snap.y), ctx.toWorld(snap.x + s, snap.y)];
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(hPts), thickMat));
        const vPts = [ctx.toWorld(snap.x, snap.y - s), ctx.toWorld(snap.x, snap.y + s)];
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vPts), thickMat.clone()));

        indicator = group;
        break;
      }
      case "intersection": {
        const bigS = s * 1.3;
        const group = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false });
        const g1 = new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(snap.x - bigS, snap.y - bigS), ctx.toWorld(snap.x + bigS, snap.y + bigS),
        ]);
        const g2 = new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(snap.x + bigS, snap.y - bigS), ctx.toWorld(snap.x - bigS, snap.y + bigS),
        ]);
        group.add(new THREE.Line(g1, mat));
        group.add(new THREE.Line(g2, mat.clone()));
        indicator = group;
        break;
      }
      case "tangent": {
        const group = new THREE.Group();
        const solidMat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false });

        const tSegments = 16;
        const tR = s * 0.6;
        const tCirclePts: THREE.Vector3[] = [];
        for (let i = 0; i <= tSegments; i++) {
          const angle = (i / tSegments) * Math.PI * 2;
          tCirclePts.push(ctx.toWorld(snap.x + Math.cos(angle) * tR, snap.y + Math.sin(angle) * tR));
        }
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tCirclePts), solidMat));

        const lineLen = s * 1.5;
        const linePts = [ctx.toWorld(snap.x - lineLen, snap.y + tR), ctx.toWorld(snap.x + lineLen, snap.y + tR)];
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), solidMat.clone()));

        indicator = group;
        break;
      }
      case "extension": {
        const group = new THREE.Group();
        const dashMat = new THREE.LineDashedMaterial({
          color: COLOR_SNAP, linewidth: 2, depthTest: false,
          dashSize: s * 0.3, gapSize: s * 0.2,
        });
        const linePts = [ctx.toWorld(snap.x - s * 1.2, snap.y), ctx.toWorld(snap.x + s * 1.2, snap.y)];
        const lineGeom = new THREE.BufferGeometry().setFromPoints(linePts);
        const line = new THREE.Line(lineGeom, dashMat);
        line.computeLineDistances();
        group.add(line);

        const sq = s * 0.4;
        const sqPts = [
          ctx.toWorld(snap.x - sq, snap.y - sq),
          ctx.toWorld(snap.x + sq, snap.y - sq),
          ctx.toWorld(snap.x + sq, snap.y + sq),
          ctx.toWorld(snap.x - sq, snap.y + sq),
          ctx.toWorld(snap.x - sq, snap.y - sq),
        ];
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(sqPts),
          new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false }),
        ));

        indicator = group;
        break;
      }
      case "perpendicular":
      case "nearest": {
        const group = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false });
        const g1 = new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(snap.x - s, snap.y - s), ctx.toWorld(snap.x + s, snap.y + s),
        ]);
        const g2 = new THREE.BufferGeometry().setFromPoints([
          ctx.toWorld(snap.x + s, snap.y - s), ctx.toWorld(snap.x - s, snap.y + s),
        ]);
        group.add(new THREE.Line(g1, mat));
        group.add(new THREE.Line(g2, mat.clone()));
        indicator = group;
        break;
      }
    }

    if (indicator) {
      indicator.name = "snap-indicator";
      indicator.traverse((child) => { child.renderOrder = 999; });
      ctx.group.add(indicator);
      this._snapIndicator = indicator;
    }

    // 좌표 텍스트 라벨은 DOM SnapInfoPanel에서 표시 (Three.js sprite 제거)
  }

  private _createCenterIndicator(ctx: OverlayRenderContext, snap: NonNullable<SnapResult>, s: number): THREE.Group {
    const group = new THREE.Group();
    const solidMat = new THREE.LineBasicMaterial({ color: COLOR_SNAP, linewidth: 2, depthTest: false });

    const segments = 24;
    const circlePts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      circlePts.push(ctx.toWorld(snap.x + Math.cos(angle) * s, snap.y + Math.sin(angle) * s));
    }
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(circlePts), solidMat,
    ));

    const extent = snap.extent ?? 0;
    const crossLen = extent + s * 3;
    const dashMat = new THREE.LineDashedMaterial({
      color: COLOR_SNAP, linewidth: 1, depthTest: false,
      dashSize: s * 0.4, gapSize: s * 0.3,
    });

    const hPts = [ctx.toWorld(snap.x - crossLen, snap.y), ctx.toWorld(snap.x + crossLen, snap.y)];
    const hLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(hPts), dashMat);
    hLine.computeLineDistances();
    group.add(hLine);

    const vPts = [ctx.toWorld(snap.x, snap.y - crossLen), ctx.toWorld(snap.x, snap.y + crossLen)];
    const vLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vPts), dashMat.clone());
    vLine.computeLineDistances();
    group.add(vLine);

    return group;
  }

  private _updateCrosshair(ctx: OverlayRenderContext): void {
    if (this._crosshairObject) {
      ctx.group.remove(this._crosshairObject);
      ctx.disposeObject(this._crosshairObject);
      this._crosshairObject = null;
    }

    if (!ctx.drawTool || !ctx.sketchPlane || !ctx.pointerPos) return;

    const { x, y } = ctx.pointerPos;
    const s = ctx.worldPerPixel * CROSSHAIR_SCREEN_PX;
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: COLOR_CROSSHAIR, linewidth: 1.5, depthTest: false });

    const hGeom = new THREE.BufferGeometry().setFromPoints([
      ctx.toWorld(x - s, y), ctx.toWorld(x + s, y),
    ]);
    group.add(new THREE.Line(hGeom, mat));

    const vGeom = new THREE.BufferGeometry().setFromPoints([
      ctx.toWorld(x, y - s), ctx.toWorld(x, y + s),
    ]);
    group.add(new THREE.Line(vGeom, mat.clone()));

    group.name = "crosshair";
    group.traverse((child) => { child.renderOrder = 997; });
    ctx.group.add(group);
    this._crosshairObject = group;
  }
}
