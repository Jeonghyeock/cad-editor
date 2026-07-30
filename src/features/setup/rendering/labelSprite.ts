// labelSprite — shared 로 이동 (src/shared/utils/labelSprite). cad-models (shared) 도
// import 가능하도록. 기존 import path 호환 위해 re-export 유지.

export {
  createScreenSpaceLabelSprite,
  type CreateLabelSpriteOptions,
} from "src/shared/utils/labelSprite";
