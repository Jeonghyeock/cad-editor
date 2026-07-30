// 기하 프리미티브 렌더링 (point, line, circle, arc, ellipse, curve)
// 면 감지, 프리뷰, 추론선, 외부 기하 렌더링 포함

import * as THREE from "three";

import type { SerializedGeometry } from "../Setup.type";
import { nurbsEvaluate } from "../sketch/curveUtils";
import type { SketchShape } from "../sketch/shapeDetector";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import { isReferenceId, REF_ORIGIN_ID } from "../sketch/SketchGeometryStore";
import type { BreakDrawTool } from "../sketch/tools/BreakDrawTool";
import type { TrimDrawTool } from "../sketch/tools/TrimDrawTool";

import { BatchedLineSegments } from "./BatchedLineSegments";
import {
  ARC_SEGMENTS,
  COLOR_AXIS,
  COLOR_CONSTRUCTION,
  COLOR_DEPENDENCY,
  COLOR_FULLY_CONSTRAINED,
  COLOR_FLASH,
  COLOR_GEOMETRY,
  COLOR_HOVERED,
  COLOR_INFERENCE,
  COLOR_OVER_CONSTRAINED,
  COLOR_PREVIEW,
  COLOR_REFERENCE,
  COLOR_REF_ORIGIN,
  COLOR_SELECTED,
  COLOR_TRIM_PREVIEW,
  AXIS_SCREEN_PX,
  HANDLE_SCREEN_PX,
  POINT_RADIUS,
} from "./overlayConstants";
import type { OverlayRenderContext, OverlaySubRenderer } from "./OverlayRenderContext";

// shape face 기본 fill opacity.
const FACE_DEFAULT_OPACITY = 0.2;

/**
 * Phase 1D color-only fast path 의 cache. _updateObject 가 mesh 의 userData._gpCache 로
 * 보관. 다음 update 시 같은 shapeKey + flags 면 mesh 재사용 + color 만 갱신.
 */
type GpPrimCache = {
  shapeKey: string;
  isDashed: boolean;
  isRef: boolean;
  isAxis: boolean;
  color: number;
};

/** 좌표 + 도형 type 의 압축 string — 변경 감지용. 동일하면 mesh 재사용 가능. */
function geomShapeKey(g: SerializedGeometry): string {
  switch (g.type) {
    case "point":
      return `p${g.x},${g.y}`;
    case "line":
      return `l${g.x1},${g.y1},${g.x2},${g.y2}`;
    case "circle":
      return `c${g.cx},${g.cy},${g.r}`;
    case "arc":
      return `a${g.cx},${g.cy},${g.r},${g.startAngle},${g.endAngle}`;
    case "ellipse":
      return `e${g.cx},${g.cy},${g.rx},${g.ry},${g.rotation ?? 0}`;
    case "polygon":
      return `g${g.vertices.map((v) => `${v.x},${v.y}`).join("|")}`;
    case "curve":
      return `n${g.points.map((v) => `${v.x},${v.y}`).join("|")}`;
    default:
      return "?";
  }
}

/** Object 의 모든 LineBasicMaterial / LineDashedMaterial / MeshBasicMaterial color 변경. */
function setObjectColor(obj: THREE.Object3D, color: number): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh | THREE.Line;
    const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (!mat) return;
    const apply = (m: THREE.Material) => {
      if ("color" in m && (m as { color: THREE.Color }).color instanceof THREE.Color) {
        (m as { color: THREE.Color }).color.setHex(color);
      }
    };
    if (Array.isArray(mat)) mat.forEach(apply);
    else apply(mat);
  });
}

export class GeometryPrimitiveRenderer implements OverlaySubRenderer {
  // 오브젝트 풀
  private _objects: Map<string, THREE.Object3D> = new Map();
  /**
   * Phase 2 — 일반 sketch line (solid, dashed-construction, dashed-hover X) 들을 단일
   * LineSegments mesh 로 batch. 사각형 같은 polygon 의 외곽 line 도 여기 들어옴 (각 edge 가
   * 별도 line geom 이므로). draw call N → 1, color 변경은 attribute mutation O(1) GPU upload.
   *
   * batch 에 들어가는 조건: type==="line" && !isAxis && !isRef && !isConstruction (= dashed X)
   * 그 외 (axis dash-dot, ref arrow, construction dashed, circle/arc/polygon 등) 는 기존
   * _updateObject path. 향후 dashed batch / circle batch 별도 추가 가능.
   */
  private _lineBatchSolid: BatchedLineSegments | null = null;
  /**
   * Phase 2.5 — dashed (construction) shape batch. solid batch 와 동일 구조에 lineDistance
   * attribute 추가 + LineDashedMaterial. construction toggle 된 line/circle/arc/ellipse/polygon
   * 이 여기 들어옴. dash phase 는 shape 내에서 연속, shape 간 독립 (set() 호출당 reset).
   */
  private _lineBatchDashed: BatchedLineSegments | null = null;
  /** batch 에 등록된 id set — _updateObject 와 sync 정리 시 구분. solid + dashed 합집합. */
  private _batchedLineIds: Set<string> = new Set();
  /** id 가 dashed batch 에 있는지 — solid 와 dashed 사이 이동 시 구분. */
  private _dashedBatchedIds: Set<string> = new Set();
  private _tmpColor = new THREE.Color();
  private _faceObjects: THREE.Object3D[] = [];
  private _previewObject: THREE.Object3D | null = null;
  private _previewObjects: THREE.Object3D[] = [];
  private _trimPreviewObject: THREE.Object3D | null = null;
  private _multiTrimPreviewObjects: THREE.Object3D[] = [];
  private _inferenceLines: THREE.Object3D[] = [];
  private _externalObjects: THREE.Object3D[] = [];
  /**
   * shape image texture 캐시 — shape.id 별. 매 sync 마다 _faceObjects clear +
   * 재생성하지만 texture 는 영속 캐시에서 재사용 (TextureLoader.load 비동기 재로드로
   * 인한 mousemove 깜빡임 방지). shape 삭제 시 _imageTexturePrune 으로 정리.
   */
  private _imageTextureCache: Map<string, THREE.Texture> = new Map();

  sync(ctx: OverlayRenderContext): void {
    if (!ctx.store || !ctx.sketchPlane) return;

    const store = ctx.store;
    const selectedSet = new Set(store.selectedIds);
    // vertex 선택된 참조 기하 ID 수집 (vertex 선택으로도 참조 기하를 표시하기 위해)
    const vertexSelectedRefIds = new Set<string>();
    for (const s of store.selection) {
      if (s.kind === "vertex" && isReferenceId(s.geomId)) {
        vertexSelectedRefIds.add(s.geomId);
      }
    }

    // 활성 기하 ID 추적
    const activeIds = new Set<string>();

    // fullRedraw가 아닐 때: dirty 기하만 업데이트
    const isDirtyOnly = !ctx.fullRedraw && ctx.dirtyGeometries.size > 0;
    const shouldProcess = (id: string) => ctx.fullRedraw || ctx.dirtyGeometries.has(id);

    for (const [id, geom] of store.geometries) {
      activeIds.add(id);

      // 다른 씬의 SO geometry 는 숨김. batch 에 stale 로 남아있을 수 있어 같이 정리.
      if (ctx.hiddenGeoIds.has(id)) {
        const existing = this._objects.get(id);
        if (existing) { ctx.group.remove(existing); ctx.disposeObject(existing); this._objects.delete(id); }
        if (this._batchedLineIds.has(id)) {
          if (this._dashedBatchedIds.has(id)) {
            this._lineBatchDashed?.remove(id);
            this._dashedBatchedIds.delete(id);
          } else {
            this._lineBatchSolid?.remove(id);
          }
          this._batchedLineIds.delete(id);
        }
        continue;
      }

      // dirty 추적 모드에서 변경되지 않은 기하는 스킵
      if (!shouldProcess(id)) continue;

      const isRef = "isReference" in geom && geom.isReference;
      const hovered = store.hoveredItem;
      const isHovered = hovered !== null && hovered.kind === "geometry" && hovered.geomId === id;

      const isConstruction = "isConstruction" in geom && geom.isConstruction;
      // REF axis (type:"axis") + revolve 회전축 (line + isAxis flag) 둘 다 axis 시각 처리 대상.
      const isAxis = geom.type === "axis" || (geom.type === "line" && "isAxis" in geom && geom.isAxis);

      let color = isAxis ? COLOR_AXIS : isConstruction ? COLOR_CONSTRUCTION : COLOR_GEOMETRY;

      // 참조 기하: 통일 검정 색상
      if (isRef) color = COLOR_REF_ORIGIN;

      if (selectedSet.has(id) || vertexSelectedRefIds.has(id)) color = COLOR_SELECTED;
      else if (isHovered) color = COLOR_HOVERED;
      else if (ctx.dependencyGeomIds.has(id)) color = COLOR_DEPENDENCY;
      else if (!isRef) {
        // 요소별 구속 상태 색상 (CATIA V5 스타일)
        const elemStatus = store.elementConstraintStatus.get(id);
        if (elemStatus === "over-constrained") {
          color = COLOR_OVER_CONSTRAINED;
        } else if (elemStatus === "fully-constrained") {
          color = COLOR_FULLY_CONSTRAINED;
        }
      }

      // Undo/Redo 플래시 (기존 색상보다 우선하지 않고, 선택/호버가 아닌 경우에만)
      if (ctx.flashGeomIds.size > 0 && !selectedSet.has(id) && !isHovered) {
        if (ctx.flashGeomIds.has("__all__") || ctx.flashGeomIds.has(id)) {
          color = COLOR_FLASH;
        }
      }

      // Phase 2/2.5: sketch shape (axis/ref 제외) 을 batch mesh 로.
      // isConstruction → dashed batch (LineDashedMaterial). 그 외 → solid batch.
      // line + circle + arc + ellipse + polygon outline 을 vertex pair 로 분할해 단일
      // LineSegments mesh. draw call 감소 + hover/select 시 color attribute mutation.
      // curve 는 control polygon + handle + tangent arrow 등 부수 UI 가 있어 batch 제외.
      const batchEligible =
        !isAxis && !isRef &&
        (geom.type === "line" ||
          geom.type === "circle" ||
          geom.type === "arc" ||
          geom.type === "ellipse" ||
          geom.type === "polygon");
      let batched = false;
      if (batchEligible) {
        batched = this._updateBatchedShape(ctx, id, geom, color, isConstruction ?? false);
      }
      if (batched) {
        // 이전에 regular path 로 만들었던 mesh 가 있으면 정리.
        const existingRegular = this._objects.get(id);
        if (existingRegular) {
          ctx.group.remove(existingRegular);
          ctx.disposeObject(existingRegular);
          this._objects.delete(id);
        }
        continue;
      }

      // batch 에 있다가 batchEligible 이 아니게 된 경우 (예: type 변경) — batch 에서 제거.
      if (this._batchedLineIds.has(id)) {
        if (this._dashedBatchedIds.has(id)) {
          this._lineBatchDashed?.remove(id);
          this._dashedBatchedIds.delete(id);
        } else {
          this._lineBatchSolid?.remove(id);
        }
        this._batchedLineIds.delete(id);
      }

      this._updateObject(ctx, id, geom, color, (isConstruction ?? false) || (isAxis ?? false), isRef, isAxis ?? false);
    }

    // 삭제된 오브젝트 정리
    for (const [id, obj] of this._objects) {
      if (!activeIds.has(id)) {
        ctx.group.remove(obj);
        ctx.disposeObject(obj);
        this._objects.delete(id);
      }
    }
    // batch 에서도 삭제된 line 정리 (solid + dashed 양쪽).
    for (const id of [...this._batchedLineIds]) {
      if (!activeIds.has(id)) {
        if (this._dashedBatchedIds.has(id)) {
          this._lineBatchDashed?.remove(id);
          this._dashedBatchedIds.delete(id);
        } else {
          this._lineBatchSolid?.remove(id);
        }
        this._batchedLineIds.delete(id);
      }
    }

    // dirty 상태가 아닌 경우 (hover/selection 변경만) 면/프리뷰/추론선은 스킵
    if (isDirtyOnly && !ctx.fullRedraw) {
      // face mesh는 재생성 없이 스타일만 갱신
      this._updateFaceStyles(store);
      return;
    }

    // Shape 면 업데이트 (재생성)
    this._updateDetectedFaces(ctx, store);

    // face mesh의 hover/selection 스타일 갱신 (재생성 후 적용)
    this._updateFaceStyles(store);

    // 프리뷰 업데이트
    this._updatePreview(ctx);

    // 추론선 업데이트
    this._updateInferenceLines(ctx);

    // 외부 기하 업데이트
    this._updateExternalGeometries(ctx);
  }

  clear(): void {
    // clear는 컨텍스트 없이 호출되므로, 오브젝트 참조만 정리
    // 실제 dispose는 orchestrator가 컨텍스트를 통해 수행
    this._objects.clear();
    this._faceObjects = [];
    this._previewObject = null;
    this._previewObjects = [];
    this._trimPreviewObject = null;
    this._multiTrimPreviewObjects = [];
    this._inferenceLines = [];
    this._externalObjects = [];
  }

  dispose(): void {
    // sub-renderer 자체 자원 해제 (없음 — 공유 geometry는 ctx 소유)
  }

  // orchestrator의 _clearAll에서 호출하여 그룹에서 제거 + dispose 수행
  clearAll(ctx: OverlayRenderContext): void {
    for (const [, obj] of this._objects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._objects.clear();
    // Batch line mesh 정리 (solid + dashed)
    if (this._lineBatchSolid) {
      ctx.group.remove(this._lineBatchSolid.mesh);
      this._lineBatchSolid.dispose();
      this._lineBatchSolid = null;
    }
    if (this._lineBatchDashed) {
      ctx.group.remove(this._lineBatchDashed.mesh);
      this._lineBatchDashed.dispose();
      this._lineBatchDashed = null;
    }
    this._batchedLineIds.clear();
    this._dashedBatchedIds.clear();

    if (this._previewObject) {
      ctx.group.remove(this._previewObject);
      ctx.disposeObject(this._previewObject);
      this._previewObject = null;
    }

    for (const obj of this._previewObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._previewObjects = [];

    if (this._trimPreviewObject) {
      ctx.group.remove(this._trimPreviewObject);
      ctx.disposeObject(this._trimPreviewObject);
      this._trimPreviewObject = null;
    }

    for (const obj of this._multiTrimPreviewObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._multiTrimPreviewObjects = [];

    for (const obj of this._inferenceLines) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._inferenceLines = [];

    for (const obj of this._externalObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._externalObjects = [];

    for (const obj of this._faceObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._faceObjects = [];
  }

  // --- 기하 생성 공용 메서드 (ConstraintRenderer에서도 사용) ---
  createGeometryObject(
    ctx: OverlayRenderContext,
    geom: SerializedGeometry,
    color: number,
    isDashed: boolean,
    isRef = false,
  ): THREE.Object3D | null {
    switch (geom.type) {
      case "point":
        return this._createPoint(ctx, geom.x, geom.y, color);
      case "line":
        return this._createLine(ctx, geom.x1, geom.y1, geom.x2, geom.y2, color, isDashed);
      case "circle":
        return this._createCircle(ctx, geom.cx, geom.cy, geom.r, color, isDashed);
      case "arc":
        return this._createArc(ctx, geom.cx, geom.cy, geom.r, geom.startAngle, geom.endAngle, color, isDashed);
      case "curve":
        return this._createCurve(ctx, geom.points, color, isDashed, geom.degree, geom.knots, geom.weights, geom.tangentStart, geom.tangentEnd, isRef);
      case "ellipse":
        return this._createEllipse(ctx, geom.cx, geom.cy, geom.rx, geom.ry, geom.rotation, color, isDashed);
      case "polygon": {
        if (!geom.vertices || geom.vertices.length < 2) return null;
        // 외곽선 (닫힌 폴리곤)
        const polyPts = geom.vertices.map((v: { x: number; y: number }) => ctx.toWorld(v.x, v.y));
        polyPts.push(polyPts[0]); // close
        const polyGeom = new THREE.BufferGeometry().setFromPoints(polyPts);
        const polyMat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
        return new THREE.Line(polyGeom, polyMat);
      }
      default:
        return null;
    }
  }

  // --- private ---

  private _getConstrainedGeomIds(ctx: OverlayRenderContext): Set<string> {
    const ids = new Set<string>();
    if (!ctx.constraintStore) return ids;
    for (const c of ctx.constraintStore.constraints.values()) {
      switch (c.type) {
        case "coincident":
          ids.add(c.pointA.geomId);
          ids.add(c.pointB.geomId);
          break;
        case "horizontal":
        case "vertical":
          ids.add(c.line.geomId);
          break;
        case "fix":
          ids.add(c.point.geomId);
          break;
        case "distance":
          ids.add(c.pointA.geomId);
          ids.add(c.pointB.geomId);
          break;
        case "equal":
        case "parallel":
        case "perpendicular":
        case "colinear":
          ids.add(c.lineA.geomId);
          ids.add(c.lineB.geomId);
          break;
        case "tangent":
          ids.add(c.entityA.geomId);
          ids.add(c.entityB.geomId);
          break;
        case "point_on_line":
        case "midpoint":
          ids.add(c.point.geomId);
          ids.add(c.line.geomId);
          break;
        case "concentric":
          ids.add(c.circleA.geomId);
          ids.add(c.circleB.geomId);
          break;
        case "point_on_circle":
          ids.add(c.point.geomId);
          ids.add(c.circle.geomId);
          break;
        case "radius":
        case "diameter":
          ids.add(c.circle.geomId);
          break;
        case "equal_radius":
          ids.add(c.circleA.geomId);
          ids.add(c.circleB.geomId);
          break;
        case "line_length":
          ids.add(c.line.geomId);
          break;
        case "angle":
          ids.add(c.lineA.geomId);
          ids.add(c.lineB.geomId);
          break;
        case "point_line_distance":
          ids.add(c.point.geomId);
          ids.add(c.line.geomId);
          break;
      }
    }
    return ids;
  }

  private _updateDetectedFaces(ctx: OverlayRenderContext, store: SketchGeometryStore): void {
    for (const obj of this._faceObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._faceObjects = [];

    if (!ctx.sketchPlane || store.shapes.length === 0) return;

    // 각 shape을 독립적으로 렌더링
    for (const ss of store.shapes) {
      // shape의 모든 lineIds가 숨겨진 경우 face도 스킵 (다른 씬의 SO)
      if (ss.lineIds.length > 0 && ss.lineIds.every((lid) => ctx.hiddenGeoIds.has(lid))) continue;

      const verts = ss.vertices;
      if (verts.length < 3) continue;

      // image background shape — face mesh 대신 texture plane
      if (ss.image && ss.imageVisibility !== false) {
        this._addImagePlane(verts, ss.image, ss.id, ctx);
        continue;
      }

      this._addFaceMesh(verts, ss, store, ctx);
    }

    // image texture cache 의 stale entry 정리 — shape 가 사라졌으면 texture dispose.
    const activeImageShapeIds = new Set(
      store.shapes.filter((s) => s.image).map((s) => s.id),
    );
    for (const [id, tex] of this._imageTextureCache) {
      if (!activeImageShapeIds.has(id)) {
        tex.dispose();
        this._imageTextureCache.delete(id);
      }
    }
  }

  /**
   * image 가 있는 shape — vertices (사각형 4점) 으로 plane geometry + canvas texture.
   * sketch 평면 좌표계에서 vertex 위치 그대로 사용. UV 는 vertex 인덱스 순서 기반.
   * sketchPlane 의 u/v 축으로 worldspace 변환 (toWorld).
   */
  private _addImagePlane(
    verts: { x: number; y: number }[],
    dataURL: string,
    shapeId: string,
    ctx: OverlayRenderContext,
  ): void {
    if (verts.length < 3) return;
    // 일단 4 vertex 사각형 가정. 다른 shape 면 첫 4 점 사용 (또는 ShapeGeometry).
    const v = verts.length >= 4 ? verts.slice(0, 4) : [...verts, verts[0]];

    const shapeGeom = new THREE.BufferGeometry();
    const positions = new Float32Array(4 * 3);
    const uvs = new Float32Array(4 * 2);
    // UV: 좌하 (0,0), 우하 (1,0), 우상 (1,1), 좌상 (0,1)
    const uvCoords = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const wp = ctx.toWorld(v[i].x, v[i].y);
      positions[i * 3] = wp.x;
      positions[i * 3 + 1] = wp.y;
      positions[i * 3 + 2] = wp.z;
      uvs[i * 2] = uvCoords[i][0];
      uvs[i * 2 + 1] = uvCoords[i][1];
    }
    shapeGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    shapeGeom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    // 두 삼각형으로 quad
    shapeGeom.setIndex([0, 1, 2, 0, 2, 3]);
    shapeGeom.computeVertexNormals();

    let texture = this._imageTextureCache.get(shapeId);
    if (!texture) {
      texture = new THREE.TextureLoader().load(dataURL);
      texture.colorSpace = THREE.SRGBColorSpace;
      this._imageTextureCache.set(shapeId, texture);
    }
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.5,  // problem-definition 패턴 — 사용자가 background 위 sketch 그릴 수 있도록 반투명
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(shapeGeom, mat);
    mesh.userData.isShapeImage = true;
    mesh.userData.shapeId = shapeId;
    mesh.renderOrder = -1; // 다른 sketch geometry 보다 뒤
    ctx.group.add(mesh);
    this._faceObjects.push(mesh);
  }

  /** face mesh 추가 헬퍼 */
  private _addFaceMesh(
    verts: { x: number; y: number }[],
    shape: SketchShape,
    store: SketchGeometryStore,
    ctx: OverlayRenderContext,
  ): void {
    const shapeId = shape.id;
    const sceneIndex = shape.sceneIndex;
    const threeShape = new THREE.Shape();
    threeShape.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < verts.length; i++) {
      threeShape.lineTo(verts[i].x, verts[i].y);
    }
    threeShape.closePath();

    const shapeGeom = new THREE.ShapeGeometry(threeShape);
    const posAttr = shapeGeom.getAttribute("position");
    for (let vi = 0; vi < posAttr.count; vi++) {
      const lx = posAttr.getX(vi);
      const ly = posAttr.getY(vi);
      const wp = ctx.toWorld(lx, ly);
      posAttr.setXYZ(vi, wp.x, wp.y, wp.z);
    }
    posAttr.needsUpdate = true;
    shapeGeom.computeBoundingSphere();

    const faceColor = COLOR_GEOMETRY;
    let faceOpacity = FACE_DEFAULT_OPACITY;

    // 다른 씬의 shape는 투명
    const isOtherScene = sceneIndex != null && sceneIndex !== store.currentScene;
    if (isOtherScene) faceOpacity = 0.04;

    const faceMat = new THREE.MeshBasicMaterial({
      color: faceColor, opacity: faceOpacity, transparent: true,
      side: THREE.DoubleSide, depthTest: false,
    });
    const mesh = new THREE.Mesh(shapeGeom, faceMat);
    mesh.renderOrder = 995;
    mesh.name = `shape-face-${shapeId}`;
    mesh.userData = { faceId: shapeId };
    ctx.group.add(mesh);
    this._faceObjects.push(mesh);
  }

  /** face mesh의 hover/selection 색상 갱신 */
  private _updateFaceStyles(store: SketchGeometryStore): void {
    const hoveredFaceId = store.hoveredItem?.kind === "face" ? store.hoveredItem.faceId : null;
    const selectedFaceIds = new Set(
      store.selection.filter((s): s is { kind: "face"; faceId: string } => s.kind === "face").map((s) => s.faceId),
    );

    for (const obj of this._faceObjects) {
      if (!(obj instanceof THREE.Mesh)) continue;
      const faceId = obj.userData.faceId as string;
      if (!faceId) continue;
      const mat = obj.material as THREE.MeshBasicMaterial;

      const isSelected = selectedFaceIds.has(faceId);
      const isHovered = hoveredFaceId === faceId;

      if (isSelected) {
        mat.color.setHex(COLOR_SELECTED);
        mat.opacity = 0.22;
      } else if (isHovered) {
        mat.color.setHex(COLOR_HOVERED);
        mat.opacity = 0.16;
      } else {
        mat.color.setHex(COLOR_GEOMETRY);
        mat.opacity = FACE_DEFAULT_OPACITY;
      }
    }
  }

  /**
   * sketch shape 을 batch mesh 에 등록/갱신. line / circle / arc / ellipse / polygon outline
   * 을 segment pair 로 분할해 LineSegments mesh 에 추가. isDashed=true 면 dashed batch (별도
   * mesh + LineDashedMaterial). 같은 좌표면 in-place rewrite + color mutation 만.
   */
  private _updateBatchedShape(
    ctx: OverlayRenderContext,
    id: string,
    geom: SerializedGeometry,
    color: number,
    isDashed: boolean,
  ): boolean {
    const pts = this._shapeToSegmentPairs(ctx, geom);
    if (!pts || pts.length === 0) return false;

    // dashed ↔ solid 토글 시 이전 batch 에서 제거.
    if (isDashed && this._batchedLineIds.has(id) && !this._dashedBatchedIds.has(id)) {
      this._lineBatchSolid?.remove(id);
      this._batchedLineIds.delete(id); // 함수 끝에서 다시 add — 의도 명시
    } else if (!isDashed && this._dashedBatchedIds.has(id)) {
      this._lineBatchDashed?.remove(id);
      this._dashedBatchedIds.delete(id);
    }

    this._tmpColor.setHex(color);
    if (isDashed) {
      if (!this._lineBatchDashed) {
        // 기존 _createLine / _createCircle / _createArc 의 LineDashedMaterial 와 동일 — world units.
        this._lineBatchDashed = new BatchedLineSegments({
          dashed: true,
          dashSize: 2,
          gapSize: 1,
        });
        this._lineBatchDashed.mesh.renderOrder = 0;
        ctx.group.add(this._lineBatchDashed.mesh);
      }
      this._lineBatchDashed.set(id, pts, this._tmpColor);
      this._dashedBatchedIds.add(id);
    } else {
      if (!this._lineBatchSolid) {
        this._lineBatchSolid = new BatchedLineSegments();
        this._lineBatchSolid.mesh.renderOrder = 0;
        ctx.group.add(this._lineBatchSolid.mesh);
      }
      this._lineBatchSolid.set(id, pts, this._tmpColor);
    }
    this._batchedLineIds.add(id);
    return true;
  }

  /** SerializedGeometry → LineSegments 용 vertex pair array (pair 당 1 segment). */
  private _shapeToSegmentPairs(
    ctx: OverlayRenderContext,
    geom: SerializedGeometry,
  ): THREE.Vector3[] | null {
    switch (geom.type) {
      case "line":
        return [ctx.toWorld(geom.x1, geom.y1), ctx.toWorld(geom.x2, geom.y2)];
      case "circle":
        return this._circleSegmentPairs(ctx, geom.cx, geom.cy, geom.r);
      case "arc":
        return this._arcSegmentPairs(ctx, geom.cx, geom.cy, geom.r, geom.startAngle, geom.endAngle);
      case "ellipse":
        return this._ellipseSegmentPairs(ctx, geom.cx, geom.cy, geom.rx, geom.ry, geom.rotation);
      case "polygon":
        return this._polygonSegmentPairs(ctx, geom.vertices);
      default:
        return null;
    }
  }

  private _circleSegmentPairs(
    ctx: OverlayRenderContext,
    cx: number, cy: number, r: number,
  ): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      const a0 = (i / ARC_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / ARC_SEGMENTS) * Math.PI * 2;
      pts.push(ctx.toWorld(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r));
      pts.push(ctx.toWorld(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r));
    }
    return pts;
  }

  private _arcSegmentPairs(
    ctx: OverlayRenderContext,
    cx: number, cy: number, r: number,
    startAngle: number, endAngle: number,
  ): THREE.Vector3[] {
    let sweep = endAngle - startAngle;
    // zero-sweep (startAngle === endAngle) 는 점 — full circle 로 잘못 해석하지 않도록 가드.
    if (Math.abs(sweep) < 1e-10) return [];
    if (sweep < 0) sweep += Math.PI * 2;
    const segments = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * ARC_SEGMENTS));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const a0 = startAngle + (i / segments) * sweep;
      const a1 = startAngle + ((i + 1) / segments) * sweep;
      pts.push(ctx.toWorld(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r));
      pts.push(ctx.toWorld(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r));
    }
    return pts;
  }

  private _ellipseSegmentPairs(
    ctx: OverlayRenderContext,
    cx: number, cy: number, rx: number, ry: number, rotation: number,
  ): THREE.Vector3[] {
    const segments = 64;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const t0 = (i / segments) * Math.PI * 2;
      const t1 = ((i + 1) / segments) * Math.PI * 2;
      const lx0 = rx * Math.cos(t0), ly0 = ry * Math.sin(t0);
      const lx1 = rx * Math.cos(t1), ly1 = ry * Math.sin(t1);
      pts.push(ctx.toWorld(cx + lx0 * cosR - ly0 * sinR, cy + lx0 * sinR + ly0 * cosR));
      pts.push(ctx.toWorld(cx + lx1 * cosR - ly1 * sinR, cy + lx1 * sinR + ly1 * cosR));
    }
    return pts;
  }

  private _polygonSegmentPairs(
    ctx: OverlayRenderContext,
    vertices: { x: number; y: number }[],
  ): THREE.Vector3[] | null {
    if (!vertices || vertices.length < 2) return null;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const v0 = vertices[i];
      const v1 = vertices[(i + 1) % vertices.length];
      pts.push(ctx.toWorld(v0.x, v0.y));
      pts.push(ctx.toWorld(v1.x, v1.y));
    }
    return pts;
  }

  private _updateObject(
    ctx: OverlayRenderContext,
    id: string,
    geom: SerializedGeometry,
    color: number,
    isDashed: boolean,
    isRef = false,
    isAxis = false,
  ): void {
    const existing = this._objects.get(id);

    // Color-only fast path (Phase 1D): 같은 shape (좌표/type/flags) 인데 color 만 다르면
    // mesh 재사용 + material color 만 mutation. dispose + new 회피 → hover 시 N 비례 비용 0.
    const shapeKey = geomShapeKey(geom);
    if (existing) {
      const cache = existing.userData?._gpCache as GpPrimCache | undefined;
      if (
        cache &&
        cache.shapeKey === shapeKey &&
        cache.isDashed === isDashed &&
        cache.isRef === isRef &&
        cache.isAxis === isAxis
      ) {
        if (cache.color !== color) {
          setObjectColor(existing, color);
          cache.color = color;
        }
        return; // mesh 재사용 — dispose / new geometry / new material 모두 skip
      }
    }

    if (existing) {
      ctx.group.remove(existing);
      ctx.disposeObject(existing);
    }

    // 참조 기하: 화면 고정 크기 (확대/축소해도 크기 일정)
    if (isRef) {
      const wpp = ctx.worldPerPixel;

      // 참조 축선 (type:"axis"): 원점에서 direction 방향 화살표 (화면 고정 길이)
      if (geom.type === "axis") {
        const arrowLen = wpp * AXIS_SCREEN_PX; // 120px
        const arrowHead = wpp * 8;
        const ux = geom.direction === "h" ? 1 : 0;
        const uy = geom.direction === "v" ? 1 : 0;
        const tipX = ux * arrowLen, tipY = uy * arrowLen;

        const group = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
        // 축선 본체 (실선)
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([ctx.toWorld(0, 0), ctx.toWorld(tipX, tipY)]),
          mat,
        ));
        // 화살표 머리
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            ctx.toWorld(tipX - ux * arrowHead + uy * arrowHead * 0.4, tipY - uy * arrowHead - ux * arrowHead * 0.4),
            ctx.toWorld(tipX, tipY),
            ctx.toWorld(tipX - ux * arrowHead - uy * arrowHead * 0.4, tipY - uy * arrowHead + ux * arrowHead * 0.4),
          ]),
          mat.clone(),
        ));
        group.name = `geom-${id}`;
        ctx.group.add(group);
        this._objects.set(id, group);
        return;
      }

      // 참조 원점: 화면 고정 크기 점 (실선)
      if (id === REF_ORIGIN_ID && geom.type === "point") {
        const obj = this._createPoint(ctx, geom.x, geom.y, color);
        obj.name = `geom-${id}`;
        ctx.group.add(obj);
        this._objects.set(id, obj);
        return;
      }
    }

    // REF axis (type:"axis") 는 위 isRef 분기에서 화살표로 렌더링 후 return 됨.
    // 여기 isAxis 분기는 사용자가 AxisDrawTool 로 그린 revolve 회전축 (line + isAxis flag).
    // dash-dot 으로 화면 가장자리까지 늘려 그림.
    let obj: THREE.Object3D | null;
    if (isAxis && geom.type === "line") {
      obj = this._createDashDotLine(ctx, geom.x1, geom.y1, geom.x2, geom.y2, color);
    } else {
      obj = this.createGeometryObject(ctx, geom, color, isDashed, isRef);
    }
    if (obj) {
      obj.name = `geom-${id}`;
      // color-only fast path 위한 cache. 다음 update 시 shapeKey 동일 + color 만 다르면 mesh 재사용.
      obj.userData._gpCache = {
        shapeKey,
        isDashed,
        isRef,
        isAxis,
        color,
      } satisfies GpPrimCache;
      ctx.group.add(obj);
      this._objects.set(id, obj);
    }
  }

  private _updatePreview(ctx: OverlayRenderContext): void {
    if (this._previewObject) {
      ctx.group.remove(this._previewObject);
      ctx.disposeObject(this._previewObject);
      this._previewObject = null;
    }
    for (const obj of this._previewObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._previewObjects = [];
    if (this._trimPreviewObject) {
      ctx.group.remove(this._trimPreviewObject);
      ctx.disposeObject(this._trimPreviewObject);
      this._trimPreviewObject = null;
    }
    for (const obj of this._multiTrimPreviewObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._multiTrimPreviewObjects = [];

    if (!ctx.sketchPlane) return;

    // Trim 프리뷰 (싱글)
    const trimTool = ctx.drawTool as TrimDrawTool | undefined;
    const trimPreview = trimTool?.trimPreview;
    if (trimPreview) {
      this._trimPreviewObject = this.createGeometryObject(ctx, trimPreview, COLOR_TRIM_PREVIEW, true);
      if (this._trimPreviewObject) {
        ctx.group.add(this._trimPreviewObject);
      }
    }

    // Trim 프리뷰 (멀티 드래그)
    const multiPreviews = trimTool?.multiTrimPreviews;
    if (multiPreviews && multiPreviews.length > 0) {
      for (const mp of multiPreviews) {
        const obj = this.createGeometryObject(ctx, mp, COLOR_TRIM_PREVIEW, true);
        if (obj) {
          ctx.group.add(obj);
          this._multiTrimPreviewObjects.push(obj);
        }
      }
    }

    // Break 프리뷰
    const breakPreview = (ctx.drawTool as BreakDrawTool)?.breakPreview;
    if (breakPreview) {
      const breakObj = this.createGeometryObject(ctx, breakPreview, COLOR_TRIM_PREVIEW, false);
      if (breakObj) {
        ctx.group.add(breakObj);
        this._previewObjects.push(breakObj);
      }
    }

    // 단일 프리뷰
    const preview = ctx.drawTool?.preview;
    if (preview) {
      this._previewObject = this.createGeometryObject(ctx, preview, COLOR_PREVIEW, true);
      if (this._previewObject) {
        ctx.group.add(this._previewObject);
      }
    }

    // 복수 프리뷰
    const previews = ctx.drawTool?.previews ?? [];
    for (const p of previews) {
      const obj = this.createGeometryObject(ctx, p, COLOR_PREVIEW, true);
      if (obj) {
        ctx.group.add(obj);
        this._previewObjects.push(obj);
      }
    }
  }

  private _updateInferenceLines(ctx: OverlayRenderContext): void {
    for (const obj of this._inferenceLines) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._inferenceLines = [];

    if (!ctx.drawTool || !ctx.sketchPlane) return;

    const lines = ctx.drawTool.inferenceLines;
    if (!lines || lines.length === 0) return;

    for (const line of lines) {
      const pts = [ctx.toWorld(line.x1, line.y1), ctx.toWorld(line.x2, line.y2)];
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      // Ctrl-Lock 잠긴 추론선은 실선, 일반 추론선은 점선
      const isLocked = "isLocked" in line && line.isLocked;
      const mat = isLocked
        ? new THREE.LineBasicMaterial({ color: COLOR_INFERENCE, linewidth: 2, depthTest: false })
        : new THREE.LineDashedMaterial({
          color: COLOR_INFERENCE, linewidth: 1, depthTest: false,
          dashSize: 2, gapSize: 1.5,
        });
      const obj = new THREE.Line(geom, mat);
      if (!isLocked) obj.computeLineDistances();
      obj.renderOrder = 997;
      obj.name = "inference-line";
      ctx.group.add(obj);
      this._inferenceLines.push(obj);
    }
  }

  private _updateExternalGeometries(ctx: OverlayRenderContext): void {
    for (const obj of this._externalObjects) {
      ctx.group.remove(obj);
      ctx.disposeObject(obj);
    }
    this._externalObjects = [];

    if (!ctx.sketchPlane || ctx.externalGeometries.length === 0) return;

    for (const geom of ctx.externalGeometries) {
      const obj = this.createGeometryObject(ctx, geom, COLOR_REFERENCE, true);
      if (obj) {
        obj.name = `ext-${geom.id}`;
        obj.renderOrder = 996;
        ctx.group.add(obj);
        this._externalObjects.push(obj);
      }
    }
  }

  // --- 기하 프리미티브 생성 ---

  private _createPoint(ctx: OverlayRenderContext, x: number, y: number, color: number): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false });
    const mesh = new THREE.Mesh(ctx.circleGeom, material);
    mesh.position.copy(ctx.toWorld(x, y));
    mesh.quaternion.copy(ctx.planeQuat);
    const s = ctx.worldPerPixel * HANDLE_SCREEN_PX / POINT_RADIUS;
    mesh.scale.setScalar(s);
    return mesh;
  }

  private _createLine(
    ctx: OverlayRenderContext,
    x1: number, y1: number, x2: number, y2: number,
    color: number, isDashed: boolean,
  ): THREE.Line {
    const points = [ctx.toWorld(x1, y1), ctx.toWorld(x2, y2)];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const material = isDashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1, linewidth: 2, depthTest: false })
      : new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
    const line = new THREE.Line(geom, material);
    if (isDashed) line.computeLineDistances();
    return line;
  }

  // 대시-도트 패턴 라인 (revolve 회전축용 — line + isAxis flag). 사용자가 그린 segment 를
  // 화면 가장자리까지 dashed 로 늘려 그림.
  private _createDashDotLine(
    ctx: OverlayRenderContext,
    x1: number, y1: number, x2: number, y2: number,
    color: number,
  ): THREE.Line {
    const wpp = ctx.worldPerPixel;
    const screenExtent = wpp * AXIS_SCREEN_PX;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      const nx = dx / len, ny = dy / len;
      x2 = x1 + nx * screenExtent;
      y2 = y1 + ny * screenExtent;
    }
    const points = [ctx.toWorld(x1, y1), ctx.toWorld(x2, y2)];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color,
      dashSize: wpp * 8,
      gapSize: wpp * 3,
      linewidth: 2,
      depthTest: false,
    });
    const line = new THREE.Line(geom, material);
    line.computeLineDistances();
    return line;
  }

  private _createCircle(
    ctx: OverlayRenderContext,
    cx: number, cy: number, r: number,
    color: number, isDashed: boolean,
  ): THREE.Line {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      const angle = (i / ARC_SEGMENTS) * Math.PI * 2;
      points.push(ctx.toWorld(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const material = isDashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1, linewidth: 2, depthTest: false })
      : new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
    const line = new THREE.Line(geom, material);
    if (isDashed) line.computeLineDistances();
    return line;
  }

  private _createArc(
    ctx: OverlayRenderContext,
    cx: number, cy: number, r: number,
    startAngle: number, endAngle: number,
    color: number, isDashed: boolean,
  ): THREE.Line {
    const points: THREE.Vector3[] = [];
    let sweep = endAngle - startAngle;
    // zero-sweep (startAngle === endAngle) 는 점 — full circle 로 잘못 해석하지 않도록 가드.
    // _arcSegmentPairs 와 동일 정책.
    if (Math.abs(sweep) < 1e-10) sweep = 0;
    else if (sweep < 0) sweep += Math.PI * 2;

    const segments = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * ARC_SEGMENTS));
    for (let i = 0; i <= segments; i++) {
      const angle = startAngle + (i / segments) * sweep;
      points.push(ctx.toWorld(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const material = isDashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1, linewidth: 2, depthTest: false })
      : new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
    const line = new THREE.Line(geom, material);
    if (isDashed) line.computeLineDistances();
    return line;
  }

  private _createEllipse(
    ctx: OverlayRenderContext,
    cx: number, cy: number, rx: number, ry: number, rotation: number,
    color: number, isDashed: boolean,
  ): THREE.Line {
    const segments = 64;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const lx = rx * Math.cos(t);
      const ly = ry * Math.sin(t);
      const wx = cx + lx * cosR - ly * sinR;
      const wy = cy + lx * sinR + ly * cosR;
      points.push(ctx.toWorld(wx, wy));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const material = isDashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1, linewidth: 2, depthTest: false })
      : new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
    const line = new THREE.Line(geom, material);
    if (isDashed) line.computeLineDistances();
    return line;
  }

  private _createCurve(
    ctx: OverlayRenderContext,
    pts: { x: number; y: number }[],
    color: number, isDashed: boolean,
    degree?: number, knots?: number[], weights?: number[],
    tangentStart?: { x: number; y: number },
    tangentEnd?: { x: number; y: number },
    isRef = false,
  ): THREE.Group | null {
    if (pts.length < 2) return null;
    const group = new THREE.Group();

    const interpolated = nurbsEvaluate(pts, degree, knots, weights);
    const curvePoints = interpolated.map((p) => ctx.toWorld(p.x, p.y));
    const curveGeom = new THREE.BufferGeometry().setFromPoints(curvePoints);
    const curveMat = isDashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1, linewidth: 2, depthTest: false })
      : new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
    const curveLine = new THREE.Line(curveGeom, curveMat);
    if (isDashed) curveLine.computeLineDistances();
    group.add(curveLine);

    // control polygon 점선 (reference geometry에서는 생략)
    if (pts.length >= 3 && !isRef) {
      const polyPoints = pts.map((p) => ctx.toWorld(p.x, p.y));
      const polyGeom = new THREE.BufferGeometry().setFromPoints(polyPoints);
      const polyMat = new THREE.LineDashedMaterial({
        color,
        dashSize: 3,
        gapSize: 2,
        linewidth: 1,
        depthTest: false,
        opacity: 0.35,
        transparent: true,
      });
      const polyLine = new THREE.Line(polyGeom, polyMat);
      polyLine.computeLineDistances();
      polyLine.renderOrder = 997;
      group.add(polyLine);
    }

    // control point 핸들 (reference geometry에서는 생략)
    if (isRef) return group;
    const handleScale = ctx.worldPerPixel * HANDLE_SCREEN_PX / POINT_RADIUS * 0.8;
    for (const p of pts) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        depthTest: false,
        opacity: 0.5,
        transparent: true,
      });
      const mesh = new THREE.Mesh(ctx.circleGeom, mat);
      mesh.position.copy(ctx.toWorld(p.x, p.y));
      mesh.quaternion.copy(ctx.planeQuat);
      mesh.scale.setScalar(handleScale);
      mesh.renderOrder = 998;
      group.add(mesh);
    }

    // 접선 방향 화살표 (tangentStart/tangentEnd가 있는 경우 표시)
    const arrowLen = ctx.worldPerPixel * 30; // 화살표 길이 (화면 픽셀 기준)
    const arrowHead = ctx.worldPerPixel * 5;  // 화살촉 크기
    const tanColor = COLOR_INFERENCE;

    if (tangentStart && pts.length > 0) {
      this._addTangentArrow(ctx, group, pts[0], tangentStart, arrowLen, arrowHead, tanColor);
    }
    if (tangentEnd && pts.length > 0) {
      this._addTangentArrow(ctx, group, pts[pts.length - 1], tangentEnd, arrowLen, arrowHead, tanColor);
    }

    return group;
  }

  // 접선 방향 화살표 생성 (곡선 endpoint에서 tangent 방향으로)
  private _addTangentArrow(
    ctx: OverlayRenderContext,
    group: THREE.Group,
    origin: { x: number; y: number },
    tangent: { x: number; y: number },
    length: number,
    headSize: number,
    color: number,
  ): void {
    const len = Math.hypot(tangent.x, tangent.y);
    if (len < 1e-9) return;
    const ux = tangent.x / len, uy = tangent.y / len;
    const tipX = origin.x + ux * length;
    const tipY = origin.y + uy * length;

    const mat = new THREE.LineBasicMaterial({ color, linewidth: 1, depthTest: false, opacity: 0.6, transparent: true });

    // 화살표 본체
    const bodyGeom = new THREE.BufferGeometry().setFromPoints([ctx.toWorld(origin.x, origin.y), ctx.toWorld(tipX, tipY)]);
    const bodyLine = new THREE.Line(bodyGeom, mat);
    bodyLine.renderOrder = 999;
    group.add(bodyLine);

    // 화살촉
    const headGeom = new THREE.BufferGeometry().setFromPoints([
      ctx.toWorld(tipX - ux * headSize + uy * headSize * 0.4, tipY - uy * headSize - ux * headSize * 0.4),
      ctx.toWorld(tipX, tipY),
      ctx.toWorld(tipX - ux * headSize - uy * headSize * 0.4, tipY - uy * headSize + ux * headSize * 0.4),
    ]);
    const headLine = new THREE.Line(headGeom, mat.clone());
    headLine.renderOrder = 999;
    group.add(headLine);
  }
}
