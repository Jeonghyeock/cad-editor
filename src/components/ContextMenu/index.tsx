import { useAtom } from "jotai";
import React, { useEffect, useRef } from "react";

import { WindowChannels } from "src/app/channels/windowChannels";

import { contextMenuAtom } from "src/shared/stores/App.store";
import { clampToViewport } from "src/shared/utils/clampToViewport";

import Icon from "../Icon";

export type ContextMenuItem =
  | {
      type: "item";
      label: string;
      selected?: boolean;
      onClick: () => void;
    }
  | {
      type: "separator";
    }
  | {
      type: "label";
      label: string;
    };

const ContextMenu = () => {
  const [contextMenu, setContextMenu] = useAtom(contextMenuAtom);

  const ref = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: MouseEvent) => {
    setContextMenu((prevState) => ({
      ...prevState,
      visible: true,
      x: e.pageX,
      y: e.pageY,
    }));
  };

  const handleMouseDown = (e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setContextMenu((prevState) => ({
        ...prevState,
        visible: false,
        items: [],
      }));
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setContextMenu((prevState) => ({
        ...prevState,
        visible: false,
        items: [],
      }));
    }
  };

  const handleInspect = () => {
    electron.ipcRenderer.send(WindowChannels.INSPECT_ELEMENT, [
      contextMenu.x,
      contextMenu.y,
    ]);
  };

  useEffect(() => {
    window.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []); // eslint-disable-line

  // viewport 경계 체크: 메뉴가 화면 밖으로 나가면 위치 조정 (clampToViewport 공통 util).
  useEffect(() => {
    if (!contextMenu.visible || !ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const { x, y } = clampToViewport(contextMenu.x, contextMenu.y, rect.width, rect.height);
    if (x !== contextMenu.x || y !== contextMenu.y) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y, contextMenu.items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (
    !contextMenu.visible ||
    (process.env.NODE_ENV !== "development" && !contextMenu.items.length)
  ) {
    return null;
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ top: contextMenu.y, left: contextMenu.x }}
      onClick={() => {
        setContextMenu((prev) => ({ ...prev, visible: false, items: [] }));
      }}
    >
      {contextMenu.items.map((item, i) => {
        if (item.type === "separator") {
          return <div key={i} className="context-menu__separator" />;
        }
        if (item.type === "label") {
          return (
            <div key={i} className="context-menu__label">
              {item.label}
            </div>
          );
        }
        return (
          <div key={i} className="context-menu__item" onClick={item.onClick}>
            {item.selected && <Icon.Dot />}
            {item.label}
          </div>
        );
      })}
      {process.env.NODE_ENV === "development" && (
        <div className="context-menu__item" onClick={handleInspect}>
          Inspect
        </div>
      )}
    </div>
  );
};

export default ContextMenu;
