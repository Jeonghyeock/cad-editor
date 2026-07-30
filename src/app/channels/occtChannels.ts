// OCCT Native Addon IPC 채널 상수
// renderer와 main process 양쪽에서 사용

export const OcctChannels = {
  PING: "occt:ping",
  GET_VERSION: "occt:getVersion",
  READ_STEP_FILE: "occt:readStepFile",
  EXTRACT_EDGES: "occt:extractEdges",
  BUILD_PRISM: "occt:buildPrism",
  BUILD_REVOLUTION: "occt:buildRevolution",
  PERFORM_BOOLEAN: "occt:performBoolean",
  APPLY_FILLET: "occt:applyFillet",
  APPLY_CHAMFER: "occt:applyChamfer",
  APPLY_SHELL: "occt:applyShell",
  TESSELLATE_SHAPE: "occt:tessellateShape",
  RELEASE_SHAPE: "occt:releaseShape",
  RELEASE_ALL_SHAPES: "occt:releaseAllShapes",
  // Phase 1: Sketch → Wire/Face
  MAKE_WIRE_FROM_SKETCH: "occt:makeWireFromSketch",
  MAKE_FACE_FROM_WIRE: "occt:makeFaceFromWire",
  MAKE_EDGE: "occt:makeEdge",
  // Phase 1: PartDocument + Feature Tree
  CREATE_DOCUMENT: "occt:createDocument",
  RELEASE_DOCUMENT: "occt:releaseDocument",
  ADD_SKETCH_FEATURE: "occt:addSketchFeature",
  ADD_PAD_FEATURE: "occt:addPadFeature",
  ADD_POCKET_FEATURE: "occt:addPocketFeature",
  ADD_REVOLVE_FEATURE: "occt:addRevolveFeature",
  ADD_FILLET_FEATURE: "occt:addFilletFeature",
  ADD_CHAMFER_FEATURE: "occt:addChamferFeature",
  GET_FEATURE_TREE: "occt:getFeatureTree",
  UPDATE_FEATURE: "occt:updateFeature",
  REMOVE_FEATURE: "occt:removeFeature",
  GET_SHAPE_TOPOLOGY: "occt:getShapeTopology",
  EXPORT_STEP: "occt:exportStep",
  /** Save dialog + exportStep 통합 — renderer 가 handle 만 보내고 main 이 save dialog. */
  EXPORT_STEP_WITH_DIALOG: "occt:exportStepWithDialog",
  EXPORT_IGES: "occt:exportIges",
  /** Save dialog + exportIges 통합 — renderer 가 handle 만 보내고 main 이 save dialog. */
  EXPORT_IGES_WITH_DIALOG: "occt:exportIgesWithDialog",
  // Phase 4: Topology picking
  TESSELLATE_SHAPE_WITH_TOPOLOGY: "occt:tessellateShapeWithTopology",
  // Phase 5: Document serialization
  SERIALIZE_DOCUMENT: "occt:serializeDocument",
  DESERIALIZE_DOCUMENT: "occt:deserializeDocument",
} as const;
