
import type { GlobalHistoryManager } from "./core/GlobalHistoryManager";
import type { Pick3DTarget } from "./rendering/picking/EntityPicker";
import type { DimensionConstraintType } from "./sketch/constraints/ConstraintValidator";
import type {
  SketchConstraint,
  SolveStatus,
} from "./sketch/constraints/SketchConstraint.type";
import type { SketchConstraintSolver } from "./sketch/constraints/SketchConstraintSolver";
import type { SketchConstraintStore } from "./sketch/constraints/SketchConstraintStore";
import type { SketchGeometryStore } from "./sketch/SketchGeometryStore";
import type { DrawTool } from "./sketch/tools/DrawTool";

export type Vec3 = { x: number; y: number; z: number };


// STEP 모델의 메시 단위 데이터
/** Runtime form — positions/normals 가 number[] (Three.js render 직접 사용). */
export type StepBodyData = {
  name: string;
  color?: string; // hex 색상
  positions: number[]; // flat xyz vertices
  normals: number[]; // flat xyz normals
  indices: number[]; // triangle indices
  brepFaces: {
    first: number; // index 배열 내 시작 오프셋
    last: number; // index 배열 내 끝 오프셋
    color?: string; // face별 hex 색상
  }[];
};

export type StepModelData = {
  id: string;
  fileName: string;
  bodies: StepBodyData[];
  transform: {
    position: Vec3;
    rotation: Vec3;
    scale: number;
  };
  // Native Addon shape handle (C++ 측 TopoDS_Shape 참조, edge 추출/Boolean용)
  nativeShapeHandle?: number;
};

/** Serialized form — positions/normals 가 base64 string (디스크 + globalData 형식). */
export type SerializedStepBodyData = Omit<
  StepBodyData,
  "positions" | "normals"
> & {
  positions: string; // base64
  normals: string; // base64
};

export type SerializedStepModelData = Omit<
  StepModelData,
  "bodies" | "nativeShapeHandle"
> & {
  bodies: SerializedStepBodyData[];
  // nativeShapeHandle 은 transient 라 직렬화에서 제외 (load 시 재생성).
};

export type CrossSectionDef =
  | { type: "face"; faceGroupId: number }
  | { type: "plane"; origin: Vec3; normal: Vec3 };

export type ReferenceProfile = {
  id: string;
  sourceModel: string;
  crossSection: CrossSectionDef;
  segmentIds: string[];
};

// 스케치 평면 좌표계 정의
export type SketchPlane = {
  origin: Vec3;
  normal: Vec3;
  u: Vec3; // local X axis
  v: Vec3; // local Y axis
};

// SpecTree에 표시할 스케치 엔트리
export type SketchTreeEntry = {
  planeKey: string;
  planeName: string; // "XY Plane", "YZ Plane" 등
  plane: SketchPlane;
};

// SpecTree 스케치 모드용: 기하 항목
export type SketchGeometryTreeItem = {
  id: string;
  type: string; // "Line", "Circle", "Arc", "Point", "Curve", "Ellipse"
  label: string; // "Line.1", "Circle.2" 등
  isConstruction?: boolean;
  isReference?: boolean;
};

// SpecTree 스케치 모드용: Shape 항목
export type SketchShapeTreeItem = {
  id: string;
  label: string; // "Shape 1", "Shape 2" — suffix 빼고 본문만.
  /** "[Image N]" 등 suffix + 색. SpecTree 가 별도 span 으로 분리 렌더 + inline color
   *  적용 — 라벨 전체가 아니라 suffix 만 색칠. */
  labelSuffix?: { text: string; color: string };
  lineIds: string[]; // 구성 geometry ID (tree에서 children 매핑용)
};

// Connect 도구 연속성 모드 (CATIA V5: G0 위치 연속, G1 접선 연속, G2 곡률 연속)
export type ConnectContinuity = "G0" | "G1" | "G2";

// Pattern 파라미터 (Rectangular/Circular 공용 + User)
// Dimension 배치 모드 (CATIA V5: Single / Chain / Baseline)
// - single: 매 치수 독립
// - chain: 이전 치수 끝점을 다음 치수 시작점으로 자동 연결 (점→점→점 직선상 연속 치수)
// - baseline: 첫 치수의 시작점을 모든 후속 치수의 시작점으로 고정 (누적 베이스라인 치수)
export type DimensionChainMode = "single" | "chain" | "baseline";

// SpecTree 스케치 모드용: 구속조건 항목
export type SketchConstraintTreeItem = {
  id: string;
  type: string; // 구속 타입 라벨 ("Coincidence", "Length" 등, 표시용)
  rawType?: string; // 내부 SketchConstraint["type"] (기능적 분기용 — 예: fix_together)
  label: string; // "Coincidence.1", "Length.1 = 50" 등
  hasValue?: boolean;
  value?: number;
};

// 직렬화된 스케치 데이터 (평면별 저장)
export type SerializedSketch = {
  plane: SketchPlane;
  /** 사용자가 부여한 sketch 이름 (예: "Sketch 1"). 없으면 SpecTree 가 planeKey 로 fallback. */
  name?: string;
  geometries?: SerializedGeometry[];
  constraints?: SketchConstraint[];
  shapes?: {
    id: string;
    lineIds: string[];
    planeKey: string;
    sceneIndex?: number;
    sceneRange?: { from: number; to: number };
    baseAngle: number;
    holes: [];
    vertices: { x: number; y: number }[];
    image?: string;
    imageVisibility?: boolean;
    /** 출처 — undefined 이면 declared 로 fallback (구 버전 호환). */
    origin?: "declared" | "detected";
  }[];
};

// Pad/Pocket 작업 정의
export type PadPocketDirection =
  | "normal"
  | "reverse"
  | "both"
  | "two-dimensions";

export type PadPocketOperation = {
  id: string;
  type: "pad" | "pocket";
  sketchPlaneKey: string; // 소스 스케치 참조
  profileIds: string[]; // 돌출할 기하 ID 목록
  sourceLineIds?: string[][]; // 각 profileId의 lineIds (스케치 수정 시 rebuild 재매핑용)
  depth: number; // 돌출 깊이 (mm)
  depth2?: number; // 반대방향 깊이 (two-dimensions 모드)
  direction: PadPocketDirection;
  draftAngle?: number; // 드래프트 각도 (도, 0 = 테이퍼 없음)
  targetOperationId?: string; // 부울 대상 솔리드 ID (없으면 독립 생성)
};

// Revolve 작업 정의
export type RevolveDirection =
  | "normal"
  | "reverse"
  | "symmetric"
  | "two-angles";

export type RevolveOperation = {
  id: string;
  type: "revolve";
  sketchPlaneKey: string;
  profileIds: string[];
  sourceLineIds?: string[][]; // 각 profileId의 lineIds (스케치 수정 시 rebuild 재매핑용)
  angle: number; // 회전 각도 (도, 0~360)
  angle2?: number; // 반대방향 각도 (two-angles 모드)
  axisType: "x" | "y" | "custom"; // 회전축 (스케치 좌표계 기준)
  axisOrigin?: { x: number; y: number }; // custom 축 원점
  axisDirection?: { x: number; y: number }; // custom 축 방향
  revolveDirection?: RevolveDirection; // 회전 방향 (기본 "normal")
  clockwise?: boolean; // true = CW (기본 CCW)
};

// 모든 3D 작업 유니언 (현재 PadPocket / Revolve 만 지원)
export type SolidOperation = PadPocketOperation | RevolveOperation;

// SpecTree에 표시할 작업 엔트리
export type OperationTreeEntry = {
  operation: SolidOperation;
  sketchPlaneName: string;
};

// Multi-body 관리
export type SolidBody = {
  id: string;
  name: string; // 사용자 지정 이름 (e.g., "Body.1")
  operationIds: string[]; // 이 바디에 속하는 operation ID 목록 (순서 유지)
};

// --- Assembly Constraint (조립 구속조건) ---

// 구속조건 대상 참조 (모델의 면 또는 작업의 면)
export type ConstraintTarget =
  | {
      kind: "model-face";
      modelId: string;
      bodyIndex: number;
      faceIndex: number;
    }
  | { kind: "operation"; operationId: string }
  | { kind: "origin-plane"; planeIndex: number };

// 구속조건 타입
export type AssemblyConstraintType =
  | "coincident"
  | "coaxial"
  | "offset"
  | "angle"
  | "fix";

// 구속조건 정의
export type AssemblyConstraint = {
  id: string;
  type: AssemblyConstraintType;
  targetA: ConstraintTarget;
  targetB: ConstraintTarget;
  value?: number; // offset 거리 또는 angle 각도
};

// SpecTree에 표시할 구속조건 엔트리
export type ConstraintTreeEntry = {
  constraint: AssemblyConstraint;
  labelA: string;
  labelB: string;
};

// 기하 요소의 개별 꼭짓점/끝점 핸들
export type VertexHandle = {
  geomId: string;
  vertexIndex: number;
  x: number;
  y: number;
};

// CATIA식 통합 선택 항목: 기하와 vertex가 한 배열에 공존
export type SelectionItem =
  | { kind: "geometry"; geomId: string }
  | {
      kind: "vertex";
      geomId: string;
      vertexIndex: number;
      x: number;
      y: number;
    }
  | { kind: "face"; faceId: string };

// 통합 hover 항목: 기하, vertex, 구속조건, face를 하나의 discriminated union으로 관리
export type HoverItem =
  | { kind: "geometry"; geomId: string }
  | {
      kind: "vertex";
      geomId: string;
      vertexIndex: number;
      x: number;
      y: number;
    }
  | { kind: "constraint"; constraintId: string }
  | { kind: "face"; faceId: string };

/** 거리 기반 hitTest 결과 (PD search() 동일 패턴 — 모든 요소의 거리를 비교하여 최근접 선택) */
export type HitResult =
  | {
      kind: "vertex";
      distance: number;
      geomId: string;
      vertexIndex: number;
      x: number;
      y: number;
    }
  | {
      kind: "geometry";
      distance: number;
      geomId: string;
      /** PreSelection Navigator 라벨 분기용 — `kind: "geometry"` 안에 point / axis /
       * 일반 edge (arc/circle/line 등) 가 다 섞여 있어 추가 분류 필요. 미지정 = 일반 edge. */
      geomSubKind?: "point" | "axis";
    }
  | { kind: "face"; distance: number; faceId: string }
  | { kind: "constraint"; distance: number; constraintId: string };

// 스케치 그리기 도구 타입 (UI 모드). "rectangle"은 도구 모드이며 SerializedGeometry에는 존재하지 않음 (4개 line으로 분해)
export type SketchDrawToolType =
  | "select"
  | "point"
  | "line"
  | "rectangle"
  | "oriented-rectangle"
  | "circle"
  | "three-point-circle"
  | "arc"
  | "three-point-arc"
  | "curve"
  | "ellipse"
  | "elongated-hole"
  | "hexagon"
  | "trim"
  | "fillet"
  | "chamfer"
  | "mirror"
  | "offset"
  | "corner"
  | "translate"
  | "rotate"
  | "scale"
  | "break"
  | "parallelogram"
  | "centered-rectangle"
  | "centered-parallelogram"
  | "cylindrical-elongated-hole"
  | "keyhole"
  | "bisecting-line"
  | "point-coordinates"
  | "equidistant-points"
  | "intersection-point"
  | "close"
  | "complement"
  | "extend"
  | "isolate"
  | "symmetry-move"
  | "profile"
  | "oblong"
  | "trapezoid"
  | "hyperbola"
  | "parabola"
  | "conic"
  | "connect"
  | "dimension"
  | "axis"
  | "tri-tangent-circle"
  | "infinite-line"
  | "bi-tangent-line"
  | "line-normal"
  | "pattern-rectangular"
  | "pattern-circular"
  | "pattern-user";

// 선택된 기하의 속성 정보 (SnapInfoPanel에 표시)
export type SelectionPropertyInfo =
  | { type: "point"; x: number; y: number }
  | {
      type: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      length: number;
      angle: number;
    }
  | { type: "circle"; cx: number; cy: number; r: number }
  | {
      type: "arc";
      cx: number;
      cy: number;
      r: number;
      startAngle: number;
      endAngle: number;
      sweep: number;
    }
  | { type: "curve"; controlPointCount: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { type: "polygon"; vertexCount: number }
  | { type: "reference"; name: string }
  | {
      type: "shape";
      shapeId: string;
      area: number;
      edgeCount: number;
    }
  | { type: "multi"; count: number };

// 직렬화된 기하 프리미티브
// isReference: 원점/축선 등 편집 불가 참조 기하 (삭제/이동 불가, 직렬화 제외, dimension 대상으로만 사용)
export type SerializedGeometry =
  | {
      type: "point";
      id: string;
      x: number;
      y: number;
      isConstruction?: boolean;
      isReference?: boolean;
    }
  | {
      type: "line";
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      isConstruction?: boolean;
      isReference?: boolean;
      isAxis?: boolean;
    }
  | {
      type: "circle";
      id: string;
      cx: number;
      cy: number;
      r: number;
      isConstruction?: boolean;
      isReference?: boolean;
    }
  | {
      type: "arc";
      id: string;
      cx: number;
      cy: number;
      r: number;
      startAngle: number;
      endAngle: number;
      isConstruction?: boolean;
      isReference?: boolean;
    }
  | {
      type: "curve";
      id: string;
      points: { x: number; y: number }[];
      degree?: number;
      knots?: number[];
      weights?: number[];
      tangentStart?: { x: number; y: number };
      tangentEnd?: { x: number; y: number };
      isConstruction?: boolean;
      isReference?: boolean;
    }
  | {
      type: "ellipse";
      id: string;
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rotation: number;
      isConstruction?: boolean;
      isReference?: boolean;
    }
  | {
      type: "polygon";
      id: string;
      vertices: { x: number; y: number }[];
      lineIds: string[];
      isConstruction?: boolean;
      isReference?: boolean;
    }
  | {
      // CATIA H/V axis 식 — 좌표 없이 (origin, direction) 만 가지는 무한선.
      // 원점 (0,0) 을 통과하고 direction 방향으로 무한히 뻗음. 가짜 endpoint vertex 없음 (line
      // 의 stored x1,y1,x2,y2 가 unit vector 가 되어 snap/hit-test/solver pointRegistry 에
      // 가짜 (1,0)/(0,1) vertex 가 누출되던 문제 해결).
      type: "axis";
      id: string;
      direction: "h" | "v";
      isReference: true;
    };

// --- Input Feature 영속화 데이터 ---

/**
 * 3D 카메라 상태 — 파일별 격리되지만 디스크 (.cad) 에는 저장 안 됨.
 * GlobalData (메모리, atomFamily 의 fileId 별 인스턴스) 에는 보관 → 파일 전환 시 복원.
 * 앱 재시작 시 초기화.
 */
export type SetupCameraState = {
  // perspective 카메라 (3D 모드)
  persp: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    up: [number, number, number];
  };
  // OrbitControls target
  target: [number, number, number];
};


export type SetupPersistentData = {
  // models 는 serialized form (positions/normals 가 base64). runtime form (number[]) 은
  // setupModelsAtom (transient) 가 보유. file load 시 deserialize → atom 채움.
  // (projectMode 는 GlobalData root field 로 hoist — 여기 안 들어감.)
  models: SerializedStepModelData[];
  sketches: SerializedSketch[];
  operations: OperationTreeEntry[];
  referencePlanes: ReferencePlane[];
  viewState: {
    mode: "3d" | "2d-section";
    /**
     * 현재 활성 timeline scene 인덱스 — 메모리 전용 (cameraState 와 동일하게 디스크 저장 X).
     * scene 전환은 view navigation 이라 ctrl+z 대상도 아니고 파일에도 안 저장. 새 파일 열면
     * 항상 0 부터 시작.
     */
    currentScene: number;
    // sketch 모드 진입 시만 설정됨 (3D 모드에서는 undefined)
    sketchPlaneKey?: string;
    sketchPlaneName?: string;
    /**
     * STEP body face 위에 sketch 진입한 경우의 face 출처. 파일 복원 시 face 의 SketchPlane 을
     * applyCrossSection 으로 재계산하기 위해 필요. origin/reference plane sketch 는 undefined.
     */
    sketchFaceSource?: { modelId: string; faceGroupId: number };
  };
  /**
   * SpecTree visibility 상태 — 파일별로 영속화 (CAD 관례: 의도적 숨김은 file state).
   * JSON 직렬화 가능한 array/Record 로 저장; runtime atom 은 Map/Set 으로 노출.
   */
  visibility: {
    /** 전체 숨긴 STEP model ID. */
    hiddenModels: string[];
    /** modelId → 숨긴 body index 목록. */
    hiddenBodies: Record<string, number[]>;
    /** modelId → 삭제된 body index 목록 (SpecTree 표시 제외). */
    deletedBodies: Record<string, number[]>;
    /** 숨긴 sketch planeKey 목록. */
    hiddenSketches: string[];
    /** 숨긴 solid operation (Pad/Pocket/Revolve) ID 목록. */
    hiddenOperations: string[];
    /** 숨긴 definition / sketch shape id 목록 (SpecTree Definition entry + 일반 shape). */
    hiddenShapeIds: string[];
    /** "Sketch" sub-entry 가 hide 된 sketch planeKey (role-less primitive/shape 만 숨김). */
    hiddenSketchPortions: string[];
    /** SpecTree constraint visibility (SpecTree 의 Constraints group eye toggle). */
    constraintVisible: boolean;
    /** Geometric / Dimensional constraint filter (SpecTree filter). */
    constraintVisibilityFilter: { geometric: boolean; dimensional: boolean };
  };



  // Target Marker 는 별도 atom 으로 두지 않고 markers (MarkerData[]) 의 link === "" 인 항목
  // = link 가 없는 user marker 로 통합 관리. file save 도 markers field 안에 자동 포함.

  // dmuAnalysis / optimization / generativeDesign 은 GlobalData root 로 hoist 됨 — setup
  // /setupGen 의 modeling 과 분리되어 mode 무관 공통 storage. SetupData 에는 없음.
};




/**
 * Input feature 의 메모리 데이터 통합 타입.
 * = SetupPersistentData (디스크 .cad 저장) + 메모리 전용 필드 (cameraState 등)
 *
 * GlobalData.input 의 타입. atomFamily(fileId) 로 파일별 격리.
 * 디스크 저장 시 `utils/serialization.ts` 의 `extractSetupPersistentData` 로
 * SetupPersistentData 만 추출.
 */
/**
 * 3D viewport hover/selection — origin plane / reference plane / extruded solid /
 * definition shape entry. ViewportHoverItem 은 Setup.store.ts 에서도 사용되지만 type cycle
 * 회피 위해 여기 정의 + store 에서 re-export.
 */
export type ViewportHoverItem =
  | { kind: "originPlane"; index: number }
  | { kind: "referencePlane"; id: string }
  | { kind: "solid"; operationId: string }
  /** definition shape — sketch baked role-shape (BakedShapeRenderer) 의 id. */
  | { kind: "definitionShape"; id: string };

/**
 * Page-scoped transient state — globalData.{setup, setupGen, result, explore} storage 별
 * 별도 instance. **파일 저장 X** (extractSetupPersistentData 가 omit — 명시 field 복사라
 * 자동 제외).
 *
 * **사용자 의도**: setup-DMU ↔ setup-GD ↔ result 페이지 mode 토글 시 transient state 가
 * 격리되어 mode 별 다른 UI state (canUndo / solve status / DOF / hover / selection 등) 보존.
 * 이전엔 module-level `atom(...)` 으로 모든 storage 가 같은 instance 공유 → mode toggle
 * 시 다른 모드의 state 가 보이는 회귀. SetupData & SetupTransientState intersection 으로
 * 옮겨 setupAtom dispatch 가 자동.
 *
 * **non-optional field + INITIAL default 보장** — atom getter 가 직접 read.
 * INITIAL_SETUP_DATA 에 모든 field 기본값.
 *
 * 점진 확장 — Sub-step 1 (History), Sub-step 2 (Selection/Hover) … 마다 field 추가.
 */
export type SetupTransientState = {
  /**
   * 3D 카메라 상태 — storage 별 독립 (DMU 의 setup / GD 의 setupGen / result 각자 자기
   * 카메라). Generate 후 setupGen 이 deep clone 으로 독립 진화하는 것과 정합 — 사용자가
   * GD 에서 카메라 이동해도 DMU 카메라는 자기 위치 유지. disk 저장 X (메모리 전용).
   */
  cameraState: SetupCameraState | null;
  // ── Sub-step 1: History (canUndo/canRedo + flash + solver state) ──
  // history 는 GlobalHistoryManager 단일 시스템 — LinkageEngine 의 canUndo/canRedo
  // mirror 는 dead (read 하는 consumer 없음) 이라 제거.
  /**
   * undo / redo stack manager — file 별 격리 (setupAtom 이 storage-scoped, atomFamily 가
   * fileId 별로 fresh instance 주입). 파일 이동 후 재진입 시 stack 보존.
   */
  globalHistory: GlobalHistoryManager;
  globalCanUndo: boolean;
  globalCanRedo: boolean;
  // undoFlashIds 는 standalone (setupUndoFlashIdsAtom) — flash UI, mode 격리 가치 없음.
  constraintSolveStatus: SolveStatus;
  sketchDof: number;
  // engineRenderVersion 은 standalone atom (setupEngineRenderVersionAtom) — SetupData
  // field 에 없음. high-frequency mutation (매 engine.requestRender) 라 dispatch chain
  // 회피 위해 분리.
  // ── Sub-step 2: Selection / Hover ──
  // sketch/3D hover/select 6 atom 은 standalone 으로 분리 (일시 UI — mode 격리 가치 적음 +
  // drag 시 매 mouse move 마다 mutate 되면 globalData chain 비용 누적 → freeze 위험):
  //   setupSketchHoveredItem / setupSketchSelectedIds / setupSketchSelectedConstraintId /
  //   setupSelectionInfo / setup3DHover / setup3DSelection — Setup.store.ts 의 atom(...)
  //   form. SetupTransientState 에서 빠짐.
  // linkPropertyPanelLinkId / jointPropertyPanelJointId / featureParamsSelectedId /
  // addMarkerLink / markerPropsEditId 5 panel selection atom 도 standalone — 일시 dialog
  // edit target, mode 격리 가치 적음 (UI_ATOM_RESETS 로 파일 전환 격리).
  // ── Sub-step 3a: Panel open state ──
  // 도구 모드 / 옵션 / last-used value 17 atom 은 standalone 분리 (일시 / user preference —
  // mode 격리 가치 없음): drawTool / playbackMode / refPlaneMode / refPlanePreview /
  // sketchPlane / sketchPlaneSelectionPending / dimensionMode / filletMode / chamferMode /
  // offsetMode / padPocketMode / loadPanelEditType / profileMode / filletTrimMode /
  // chamferTrimMode / chamferParamInputMode / filletRadius / chamferDistance / chamferDistance2 /
  // offsetDistance / dimensionChainMode / connectContinuity / activeSketchName — Setup.store.ts
  // 의 atom(...) form.
  /** 모든 panel open state — 10개 boolean 을 1개 nested object 로 묶음. 각 atom 은
   *  setupGroupFieldAtom("panelOpen", key) 로 분기 — caller 변경 X (이전 개별 atom 과
   *  동일 인터페이스). SetupTransientState 의 top-level field 수 감소 + 의미적 grouping. */
  panelOpen: PanelOpenState;
  /** Sketch flag — 사용자 설정 (construction mode, 자동 constraint). */
  constructionMode: boolean;
  autoDimConstraint: boolean;
  autoGeoConstraint: boolean;
  // constraintVisible / constraintVisibilityFilter / linkage3DHidden 은 persistent (visibility
  // / dmuAnalysis group 으로 이동) — 파일 별로 사용자 마지막 상태 보존.
  // ── Sub-step 3b: Mode / Panel state (complex types — union / enum / nested) ──
  selectionFilter: SelectionFilterMode;
};


/**
 * Panel open boolean 10개 일괄 묶음 — SetupTransientState.panelOpen.
 * 각 panel atom (setupConstraintDialogOpenAtom 등) 은 setupGroupFieldAtom 으로 분기.
 */
export type PanelOpenState = {
  constraintDialog: boolean;
};



/**
 * SetupData = SetupPersistentData (file 저장) & SetupTransientState (session-only).
 * flat intersection — 모든 field top-level. 격리 의도는 type alias 로만 분리.
 * file save 시 extractSetupPersistentData 가 명시 field 복사로 transient 자동 제외.
 */
export type SetupData = SetupPersistentData & SetupTransientState;



// Reference Plane (사용자 정의 평면)
export type ReferencePlane = {
  id: string;
  name: string;
  plane: SketchPlane;
  creationMethod: "offset" | "through-points" | "normal-to-curve";
  sourceDescription: string;
};

// 3D 선택 필터 모드. CATIA 의 User Selection Filter 와 동치 — 단수형 enum, UI 라벨은 복수형.
// enum value | UI 라벨   | 의미
// "all"      | Selection | 모든 entity 후보 (기본값)
// "volume"   | Volumes   | 닫힌 3D solid 자체 (직육면체면 1개)
// "face"     | Faces     | solid 의 표면 한 면 (직육면체면 6개)
// "edge"     | Edges     | face 가 만나는 선 (직육면체면 12개)
// "vertex"   | Vertices  | edge 끝점 (직육면체면 8개)
export type SelectionFilterMode = "all" | "volume" | "face" | "edge" | "vertex";

// 3D edge/vertex 피킹 결과
export type EdgePickResult = {
  modelId: string;
  bodyIndex: number;
  edgeIndex: number;
  point: Vec3;
};

export type VertexPickResult = {
  modelId: string;
  bodyIndex: number;
  vertexIndex: number;
  point: Vec3;
};

// --- UI 상태 타입 (Input.store.ts에서 사용) ---

// Reference Plane 생성 모드
export type RefPlaneCreationState = {
  step: "select-plane" | "select-edge" | "input-distance";
  selectionMode: "face" | "edge";
  basePlane?: SketchPlane;
  basePlaneName?: string;
  /** edge 기반 생성 시: edge 양 끝점 + 방향 */
  edgeStart?: { x: number; y: number; z: number };
  edgeEnd?: { x: number; y: number; z: number };
};

// Pad/Pocket 생성/편집 모드 상태 (null = 비활성)
export type PadPocketModeState = {
  type: "pad" | "pocket";
  sketchPlaneKey: string;
  profileIds: string[];
  depth: number;
  direction: PadPocketDirection;
  /** 편집 중인 기존 operation ID (없으면 신규 생성) */
  editingOperationId?: string;
} | null;

// 3D에서 선택된 baked sketch face (planeKey + profileId) — 다중 선택 지원
export type SelectedSketchFace = {
  planeKey: string;
  planeName: string;
  profileId: string | null;
};

// Dimension 패널 모드 (null = 비활성). 패널은 캔버스 우상단 고정이라 mouse 좌표 불필요.
export type DimensionModeState = {
  type: DimensionConstraintType;
  defaultValue: number;
  /** 편집 중인 기존 dimension ID (신규 생성 시 undefined) */
  editConstraintId?: string;
} | null;

// Fillet 반경 입력 패널 상태 (null = 비활성)
export type FilletModeState = {
  defaultRadius: number;
} | null;

// Chamfer 파라미터 모드
export type ChamferParamMode = "symmetric" | "two-distances";

// Chamfer 거리 입력 패널 상태 (null = 비활성)
export type ChamferModeState = {
  defaultDistance: number;
  defaultDistance2?: number;
  paramMode?: ChamferParamMode;
} | null;

// Offset 거리 입력 패널 상태 (null = 비활성)
export type OffsetModeState = {
  defaultDistance: number;
} | null;

// 스냅 상태 정보 (DOM 오버레이에서 표시)
export type SnapDisplayInfo = {
  type: string; // 스냅 타입 라벨 (Endpoint, Midpoint 등)
  x: number;
  y: number;
} | null;

// Fillet/Chamfer 트림 모드 (CATIA V5: trim-all / trim-first / no-trim)
export type FilletChamferTrimMode = "trim-all" | "trim-first" | "no-trim";

// Chamfer 파라미터 입력 모드 (Gap 7: two-distances / distance-angle / angle-hypotenuse)
export type ChamferParamInputMode =
  | "two-distances"
  | "distance-angle"
  | "angle-hypotenuse";

// Profile 도구 모드 (CATIA Sketch Tools: Line/Tangent Arc/Three Point Arc 전환)
export type ProfileMode = "line" | "tangent-arc" | "three-point-arc";

// 스케치 커맨드 콜백 (ref 기반 prop drilling을 대체하는 Jotai atom)
export type SketchCommands = {
  applyConstraint: ((type: SketchConstraint["type"]) => void) | null;
  autoConstraint: (() => number) | null;
  dimensionConfirm: ((type: string, value: number) => void) | null;
  filletConfirm: ((radius: number) => void) | null;
  chamferConfirm: ((distance: number, distance2?: number) => void) | null;
  filletPreview: ((radius: number) => void) | null;
  chamferPreview: ((distance: number, distance2?: number) => void) | null;
  offsetConfirm: ((distance: number) => void) | null;
  offsetPreview: ((distance: number) => void) | null;
  projectEdges: (() => void | Promise<void>) | null;
  projectSilhouette: (() => void | Promise<void>) | null;
  intersect3D: (() => void) | null;
  sketchToolsClick: ((pos: { x: number; y: number }) => void) | null;
  sketchToolsApply: ((values: Partial<Record<string, number>>) => void) | null;
  getDrawTool: (() => DrawTool | null) | null;
  selectGeometry: ((geomId: string, ctrlKey?: boolean) => void) | null;
  selectConstraint: ((constraintId: string) => void) | null;
  deleteGeometry: ((geomId: string) => void) | null;
  toggleConstruction: ((geomId: string) => void) | null;
  deleteConstraint: ((constraintId: string) => void) | null;
  doubleClickConstraint: ((constraintId: string) => void) | null;
  constraintValueChange: ((constraintId: string, value: number) => void) | null;
  renameRigidGroup: ((constraintId: string, label: string) => void) | null;
  dissolveRigidGroup: ((constraintId: string) => void) | null;
  getAnalysisData:
    | (() => {
        geometries: Map<string, SerializedGeometry>;
        constraints: Map<string, SketchConstraint>;
        solveStatus: SolveStatus;
        dof: number;
      })
    | null;
};


// ─── Setup.store 에서 이동된 type 정의 (cycle 회피 + 일관성) ──────────────────
// store 가 import + re-export 으로 호환 유지. instance / function (createGeometryStoreBundle
// 등) 은 store 에 잔존.
// HitResult 는 이 파일 상단에서 export — 그대로 재사용.

/** SketchGeometryStore + 연관 store 인스턴스 묶음 — 모듈 레벨 단일 bundle. */
export type GeometryStoreBundle = {
  store: SketchGeometryStore;
  constraintStore: SketchConstraintStore;
  solver: SketchConstraintSolver;
};

/** Assembly Rendering — 3D 렌더 mode (linkageScene.setRenderMode). */
export type AssemblyRenderMode =
  | "shd"
  | "shd-edges"
  | "shd-edges-no-smooth"
  | "shd-edges-hidden"
  | "shd-material"
  | "wireframe";








/** CATIA PreSelection Navigator UI 상태. */
export type PreSelectionCandidate =
  | { source: "sketch"; hit: HitResult }
  | { source: "3d"; hit: Pick3DTarget };

export type PreSelectionNavState = {
  candidates: PreSelectionCandidate[];
  activeIndex: number;
  screenX: number;
  screenY: number;
} | null;
