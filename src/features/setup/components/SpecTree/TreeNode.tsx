// 범용 재귀 트리 노드 컴포넌트 — 무한 위계 지원

import React, { memo, useCallback, useState } from "react";

import Icon from "src/components/Icon";

// 범용 트리 노드 데이터 타입
export type TreeNodeData = {
  id: string;
  label: string;
  /** label 우측에 별도 색으로 표시할 suffix (예: 'Shape 1' 본문 + '[DA]' 만 brand color).
   *  3D face mesh 색과 정합 — opacity 없는 순수 hex. */
  labelSuffix?: { text: string; color: string };
  children?: TreeNodeData[];
  // 상태
  isSelected?: boolean;
  isHovered?: boolean;
  isHidden?: boolean;
  defaultExpanded?: boolean;
  // 스타일
  className?: string;
  badge?: string | number;
  info?: string;
  icon?: React.FunctionComponent; // 타입별 아이콘 (기하 항목용)
  // 이벤트
  onClick?: (e?: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onVisibilityToggle?: () => void;
};

type TreeNodeComponentProps = {
  node: TreeNodeData;
  depth?: number;
};

const TreeNodeComponent = ({ node, depth = 0 }: TreeNodeComponentProps) => {
  const [isExpanded, setIsExpanded] = useState(node.defaultExpanded ?? false);
  const hasChildren = node.children && node.children.length > 0;

  const toggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) setIsExpanded((prev) => !prev);
  }, [hasChildren]);

  // 들여쓰기는 SCSS 가 --tree-depth 로 calc — 점선 커넥터를 depth 에 맞춰 정렬하기 위함.
  const depthStyle = { "--tree-depth": depth } as React.CSSProperties;

  if (hasChildren) {
    return (
      <div className="input-spec-tree__group" style={depthStyle}>
        <div
          className={`input-spec-tree__group-header${node.className ? ` ${node.className}` : ""}${node.isSelected ? " input-spec-tree__item--selected" : ""}${node.isHovered ? " input-spec-tree__item--hovered" : ""}`}
          style={depthStyle}
          onClick={node.onClick}
          onContextMenu={node.onContextMenu}
          onDoubleClick={node.onDoubleClick}
          onMouseEnter={node.onMouseEnter}
          onMouseLeave={node.onMouseLeave}
        >
          {/* 목업 RecurDyn 식 +/− 박스 chevron — 펼침=− / 접힘=+ (CSS ::before/::after). */}
          <span
            className={`input-spec-tree__chevron${isExpanded ? "" : " input-spec-tree__chevron--collapsed"}`}
            onClick={toggleExpand}
            aria-hidden="true"
          />
          {node.onVisibilityToggle && (
            <span
              className="input-spec-tree__item-visibility"
              onClick={(e) => { e.stopPropagation(); node.onVisibilityToggle?.(); }}
            >
              {node.isHidden ? <Icon.VisibilityOff /> : <Icon.Visibility />}
            </span>
          )}
          <span>{node.label}</span>
          {node.labelSuffix && (
            <span className="input-spec-tree__item-suffix">
              [<span style={{ color: node.labelSuffix.color }}>{node.labelSuffix.text}</span>]
            </span>
          )}
          {node.badge !== undefined && (
            <span className="input-spec-tree__group-count">{node.badge}</span>
          )}
        </div>
        {isExpanded && (
          <div className="input-spec-tree__group-items">
            {node.children!.map((child) => (
              <TreeNodeComponent key={child.id} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // 리프 노드
  return (
    <div
      className={`input-spec-tree__item${node.className ? ` ${node.className}` : ""}${node.isSelected ? " input-spec-tree__item--selected" : ""}${node.isHovered ? " input-spec-tree__item--hovered" : ""}${node.isHidden ? " input-spec-tree__item--hidden" : ""}`}
      style={depthStyle}
      onClick={node.onClick}
      onDoubleClick={node.onDoubleClick}
      onContextMenu={node.onContextMenu}
      onMouseEnter={node.onMouseEnter}
      onMouseLeave={node.onMouseLeave}
    >
      {node.onVisibilityToggle && (
        <button
          className="input-spec-tree__item-visibility"
          onClick={(e) => { e.stopPropagation(); node.onVisibilityToggle?.(); }}
          type="button"
        >
          {node.isHidden ? <Icon.VisibilityOff /> : <Icon.Visibility />}
        </button>
      )}
      {node.icon && <span className="input-spec-tree__item-icon"><node.icon /></span>}
      <span className="input-spec-tree__item-name">{node.label}</span>
      {node.labelSuffix && (
        <span
          className="input-spec-tree__item-suffix"
          style={{ color: node.labelSuffix.color }}
        >
          {node.labelSuffix.text}
        </span>
      )}
      {node.info && <span className="input-spec-tree__item-info">{node.info}</span>}
    </div>
  );
};

export default memo(TreeNodeComponent);
