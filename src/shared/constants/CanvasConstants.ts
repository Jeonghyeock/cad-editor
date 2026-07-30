export const NICE_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
];
export const NICE_STEPS_INCH = [
  0.127, 0.254, 0.508, 1.27, 2.54, 5.08, 12.7, 25.4, 50.8, 127, 254, 508, 1270,
  2540,
];

export const CANVAS_COLORS = {
  WHITE: "#FFFFFF",
  GRID_LINE: "#E1E4E8",
  GRID_LINE_MINOR: "#C6CBD0",
  GRID_AXIS: "#AAB1B9",
  DESIGN_AREA: "#D9D9D9",
  DESIGN_OUTSIDE: "#EEF1F399",
  SELECT: "#159EFF",
  WARNING: "#FFC629",
  GROUND: "#1984CC",
  GROUND_TRANSPARENT: "#1984CC29",
  MOTION: "#EB3F43",
  MOTION_TRANSPARENT: "#F65A5D4D",
  OBSTACLE: "#ACB2B9",
  OBSTACLE_TRANSPARENT: "#ACB2B933",
  OBSTACLE_CENTER: "#60666C",
  INSERT: "#339EE6",
  DRAW: "#33D7E6",
};

export const CANVAS_IMAGE_WIDTH = 416;
export const CANVAS_IMAGE_HEIGHT = 234;

/** Hit-test buffer in screen pixels (divide by scale for world coords). */
export const HIT_BUFFER = 5;

/**
 * CATIA Sketcher pre-selection 우선순위에 따른 좁은 hit radius (vertex/endpoint 우선용).
 * HIT_BUFFER 대비 비율 (0.7) — 일반 edge hit 반경보다 좁게 잡아 vertex 우선시.
 */
export const VERTEX_HIT_RATIO = 0.7;

/** Default colors for joints, links, and ground symbols. */
export const JOINT_COLOR = {
  fill: "#ffffff",
  stroke: "#303336",
};

/** Base joint radius — other sizes (link width, actuator, etc.) derive from this. */
export const JOINT_RADIUS = 6;

export const LINK_COLORS = [
  "#D30509",
  "#9AC629",
  "#3C6ABB",
  "#DF4873",
  "#EE7519",
  "#459C0E",
  "#624A99",
  "#C0408C",
  "#EFB328",
];
