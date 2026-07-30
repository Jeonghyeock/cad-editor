// 중앙 집중식 DrawTool 레지스트리
// 개별 도구 import를 제거하고 레지스트리를 통해 도구를 생성/관리

import type { SketchDrawToolType } from "../../Setup.type";

import type { DrawTool } from "./DrawTool";

export type ToolGroup = "profile" | "predefined-profile" | "circle" | "spline" | "conic" | "line" | "point" | "corner" | "chamfer" | "relimit" | "transform" | "3d-geometry" | "constraint";

export type ToolRegistration = {
  type: SketchDrawToolType;
  factory: () => DrawTool;
  group: ToolGroup;
  label: string;
};

class ToolRegistry {
  private _registrations = new Map<SketchDrawToolType, ToolRegistration>();

  register(reg: ToolRegistration): void {
    this._registrations.set(reg.type, reg);
  }

  create(type: SketchDrawToolType): DrawTool | undefined {
    return this._registrations.get(type)?.factory();
  }

  createAll(): Map<SketchDrawToolType, DrawTool> {
    const map = new Map<SketchDrawToolType, DrawTool>();
    for (const [type, reg] of this._registrations) {
      map.set(type, reg.factory());
    }
    return map;
  }

  getMetadata(type: SketchDrawToolType): ToolRegistration | undefined {
    return this._registrations.get(type);
  }

  getByGroup(group: ToolGroup): ToolRegistration[] {
    return [...this._registrations.values()].filter(r => r.group === group);
  }

  getAll(): ToolRegistration[] {
    return [...this._registrations.values()];
  }
}

export const toolRegistry = new ToolRegistry();
