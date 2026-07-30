import type { ConfigData } from "../types/Config.type";

export const CONFIG_UNIT = {
  MMGS: "MMGS",
  CGS: "CGS",
  MKS: "MKS",
  IPS: "IPS",
} as const;

export const CONFIG_UNIT_LABEL = {
  [CONFIG_UNIT.MMGS]: "MMGS (millimeter, gram, second)",
  [CONFIG_UNIT.CGS]: "CGS (centimeter, gram, second)",
  [CONFIG_UNIT.MKS]: "MKS (meter, kilogram, second)",
  [CONFIG_UNIT.IPS]: "IPS (inch, pound, second)",
} as const;

export const CONFIG_UNIT_LENGTH_LABEL = {
  [CONFIG_UNIT.MMGS]: "mm",
  [CONFIG_UNIT.CGS]: "cm",
  [CONFIG_UNIT.MKS]: "m",
  [CONFIG_UNIT.IPS]: "in",
} as const;

export const CONFIG_UNIT_LENGTH_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (value: number) => value,
  [CONFIG_UNIT.CGS]: (value: number) => value / 10,
  [CONFIG_UNIT.MKS]: (value: number) => value / 1000,
  [CONFIG_UNIT.IPS]: (value: number) => value / 25.4,
} as const;

export const CONFIG_UNIT_LENGTH_REVERSE_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (value: number) => value,
  [CONFIG_UNIT.CGS]: (value: number) => value * 10,
  [CONFIG_UNIT.MKS]: (value: number) => value * 1000,
  [CONFIG_UNIT.IPS]: (value: number) => value * 25.4,
} as const;

// Force — base = N (Newton). MMGS / MKS 가 N, CGS 가 dyne (1 dyne = 1e-5 N), IPS 가 lbf
// (1 lbf = 4.4482216 N). 음수도 그대로 환산.
export const CONFIG_UNIT_FORCE_LABEL = {
  [CONFIG_UNIT.MMGS]: "N",
  [CONFIG_UNIT.CGS]: "dyn",
  [CONFIG_UNIT.MKS]: "N",
  [CONFIG_UNIT.IPS]: "lbf",
} as const;

export const CONFIG_UNIT_FORCE_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (n: number) => n,
  [CONFIG_UNIT.CGS]: (n: number) => n * 1e5,
  [CONFIG_UNIT.MKS]: (n: number) => n,
  [CONFIG_UNIT.IPS]: (n: number) => n / 4.4482216,
} as const;

export const CONFIG_UNIT_FORCE_REVERSE_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (v: number) => v,
  [CONFIG_UNIT.CGS]: (v: number) => v / 1e5,
  [CONFIG_UNIT.MKS]: (v: number) => v,
  [CONFIG_UNIT.IPS]: (v: number) => v * 4.4482216,
} as const;

// Pressure — base = Pa (N/m²). MMGS = MPa (N/mm² = 1e6 Pa), MKS = Pa, CGS = barye
// (dyn/cm² = 0.1 Pa), IPS = psi (lbf/in² ≈ 6894.76 Pa).
export const CONFIG_UNIT_PRESSURE_LABEL = {
  [CONFIG_UNIT.MMGS]: "MPa",
  [CONFIG_UNIT.CGS]: "barye",
  [CONFIG_UNIT.MKS]: "Pa",
  [CONFIG_UNIT.IPS]: "psi",
} as const;

export const CONFIG_UNIT_PRESSURE_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (pa: number) => pa / 1e6,
  [CONFIG_UNIT.CGS]: (pa: number) => pa * 10,
  [CONFIG_UNIT.MKS]: (pa: number) => pa,
  [CONFIG_UNIT.IPS]: (pa: number) => pa / 6894.757293168361,
} as const;

export const CONFIG_UNIT_PRESSURE_REVERSE_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (v: number) => v * 1e6,
  [CONFIG_UNIT.CGS]: (v: number) => v / 10,
  [CONFIG_UNIT.MKS]: (v: number) => v,
  [CONFIG_UNIT.IPS]: (v: number) => v * 6894.757293168361,
} as const;

// Density — base = kg/m³ (MKS SI). MMGS = g/mm³ (= kg/m³ × 1e-6), CGS = g/cm³ (= ×1e-3),
// IPS = lb/in³ (≈ kg/m³ / 27679.9).
export const CONFIG_UNIT_DENSITY_LABEL = {
  [CONFIG_UNIT.MMGS]: "g/mm³",
  [CONFIG_UNIT.CGS]: "g/cm³",
  [CONFIG_UNIT.MKS]: "kg/m³",
  [CONFIG_UNIT.IPS]: "lb/in³",
} as const;

export const CONFIG_UNIT_DENSITY_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (kgm3: number) => kgm3 * 1e-6,
  [CONFIG_UNIT.CGS]: (kgm3: number) => kgm3 * 1e-3,
  [CONFIG_UNIT.MKS]: (kgm3: number) => kgm3,
  [CONFIG_UNIT.IPS]: (kgm3: number) => kgm3 / 27679.904710203,
} as const;

export const CONFIG_UNIT_DENSITY_REVERSE_FUNCTION = {
  [CONFIG_UNIT.MMGS]: (v: number) => v * 1e6,
  [CONFIG_UNIT.CGS]: (v: number) => v * 1e3,
  [CONFIG_UNIT.MKS]: (v: number) => v,
  [CONFIG_UNIT.IPS]: (v: number) => v * 27679.904710203,
} as const;

export const INITIAL_CONFIG_DATA: ConfigData = {
  language: "en",
};
