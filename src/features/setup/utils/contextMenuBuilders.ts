import type { ContextMenuItem } from "src/components/ContextMenu";

import type { OperationTreeEntry } from "../Setup.type";

// --- Model / Body 우클릭 메뉴 ---

/** 개별 바디 Hide/Show 항목 */
export function buildBodyItems(options: {
  isHidden: boolean;
  onVisibilityToggle: () => void;
}): ContextMenuItem[] {
  const { isHidden, onVisibilityToggle } = options;
  return [
    {
      type: "item",
      label: isHidden ? "Show" : "Hide",
      onClick: onVisibilityToggle,
    },
    { type: "separator" },
  ];
}

/** 모델/바디 컨텍스트 메뉴 전체 조립 */
export function buildModelContextMenuItems(options: {
  bodyIndex?: number;
  isHidden: boolean;
  selectedBodiesCount: number;
  onVisibilityToggle: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  const { bodyIndex, isHidden, onVisibilityToggle, onDelete } = options;

  const items: ContextMenuItem[] = [];

  // body가 특정되면 Hide/Show 메뉴
  if (bodyIndex != null) {
    items.push(...buildBodyItems({ isHidden, onVisibilityToggle }));
  }

  items.push({
    type: "item",
    label: "Delete",
    onClick: onDelete,
  });

  return items;
}

// --- 스케치 우클릭 메뉴 ---

export function buildSketchContextMenuItems(options: {
  onEditSketch: () => void;
  onCreatePad: () => void;
  onCreatePocket: () => void;
  onCreateRevolve: () => void;
  onDeleteSketch: () => void;
}): ContextMenuItem[] {
  const { onEditSketch, onCreatePad, onCreatePocket, onCreateRevolve, onDeleteSketch } = options;
  return [
    { type: "item", label: "Edit Sketch", onClick: onEditSketch },
    { type: "separator" },
    { type: "item", label: "Create Pad", onClick: onCreatePad },
    { type: "item", label: "Create Pocket", onClick: onCreatePocket },
    { type: "item", label: "Create Revolve", onClick: onCreateRevolve },
    { type: "separator" },
    { type: "item", label: "Delete Sketch", onClick: onDeleteSketch },
  ];
}

// --- 작업(Operation) 우클릭 메뉴 ---

export function buildOperationContextMenuItems(options: {
  entry: OperationTreeEntry;
  onEdit: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  const { entry, onEdit, onDelete } = options;

  const canEdit = entry.operation.type === "pad" || entry.operation.type === "pocket";
  const items: ContextMenuItem[] = [];

  if (canEdit) {
    items.push({ type: "item", label: "Edit", onClick: onEdit });
    items.push({ type: "separator" });
  }

  items.push({ type: "item", label: "Delete", onClick: onDelete });

  return items;
}

// --- 구속조건 우클릭 메뉴 ---

export function buildConstraintContextMenuItems(options: {
  onDelete: () => void;
}): ContextMenuItem[] {
  return [
    {
      type: "item",
      label: "Delete Constraint",
      onClick: options.onDelete,
    },
  ];
}
