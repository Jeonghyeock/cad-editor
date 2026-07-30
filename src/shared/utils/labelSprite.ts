// 화면 픽셀 크기 일정 유지 label sprite 헬퍼.
// onBeforeRender 가 매 render 직전 wpp (world per pixel) 계산 → sprite.scale = wpp * targetPx.
//
// wpp 소스:
//   1) opts.wppProvider 가 있으면 그것 (SceneManager.computeActiveWpp 등 inject).
//   2) 없으면 onBeforeRender 가 받는 camera + renderer canvas height 로 self-detect.
//      - OrthographicCamera: (top - bottom) / canvasHeight / zoom
//      - PerspectiveCamera:  (2 * dist * tan(fov/2)) / canvasHeight
//        (dist = camera ↔ sprite world position)
//
// 사용처:
//   - features/setup/rendering: SolidOperationManager (Pad mesh 위 "Design Space"), Baked
//     SketchManager (baked sketch 위 "Design Area"), markerPivot (marker label).
//   - shared/cad-models: createRotationAxisIndicator (MOTION/GROUND label) — 자체 wpp
//     소스 없어 self-detect fallback.

import * as THREE from "three";

export type CreateLabelSpriteOptions = {
  text: string;
  color: string;
  position: THREE.Vector3;
  /** world unit per screen pixel — 미지정 시 onBeforeRender 가 camera 로 self-detect. */
  wppProvider?: () => number;
  /** 화면상 sprite 의 픽셀 높이. 기본 14 (marker label / shape Area label / solid Space label 공통). */
  targetPx?: number;
  /** canvas font px — 텍스트 sharpness 결정. 기본 24. */
  fontPx?: number;
  /** sprite.renderOrder. 기본 1000. */
  renderOrder?: number;
};

const _tmpSpriteWorld = new THREE.Vector3();

export function createScreenSpaceLabelSprite(opts: CreateLabelSpriteOptions): THREE.Sprite {
  const { text, color, position, wppProvider } = opts;
  const fontPx = opts.fontPx ?? 24;
  const targetPx = opts.targetPx ?? 14;
  const pad = 6;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Sprite();
  ctx.font = `bold ${fontPx}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = opts.renderOrder ?? 1000;
  sprite.position.copy(position);

  const aspect = w / h;
  sprite.onBeforeRender = (renderer, _scene, camera) => {
    let wpp = wppProvider ? wppProvider() : 0;
    if (!wpp || wpp <= 0) {
      // self-detect — camera + renderer canvas height.
      const dom = renderer.domElement;
      const ch = dom.clientHeight || dom.height || 1;
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const oc = camera as THREE.OrthographicCamera;
        const zoom = oc.zoom || 1;
        wpp = ((oc.top - oc.bottom) / ch) / zoom;
      } else if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const pc = camera as THREE.PerspectiveCamera;
        sprite.getWorldPosition(_tmpSpriteWorld);
        const dist = pc.position.distanceTo(_tmpSpriteWorld);
        wpp = (2 * dist * Math.tan((pc.fov * Math.PI) / 180 / 2)) / ch;
      } else {
        wpp = 1;
      }
    }
    const worldHeight = wpp * targetPx;
    sprite.scale.set(worldHeight * aspect, worldHeight, 1);
  };
  return sprite;
}
