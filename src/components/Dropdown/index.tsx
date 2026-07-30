import classNames from "classnames";
import { throttle } from "lodash";
import React, { useEffect, useRef, useLayoutEffect, useState } from "react";
import type { HTMLAttributes } from "react";

import type { Disclosure } from "src/shared/hooks/useDisclosure";

import DropdownButton from "./DropdownButton";
import type { DropdownButtonProps } from "./DropdownButton";

export interface DropdownProps extends HTMLAttributes<HTMLDivElement> {
  disclosure: Disclosure;
  children: React.ReactNode;
  contentStyle?: React.CSSProperties;
  classNames?: {
    base?: string;
    button?: string;
    content?: string;
  };
  onClosed?: () => void;
  toggleButtonContent?: React.ReactNode;
  toggleButtonProps?: Partial<DropdownButtonProps>;
  parentContentPosition?: { left: number; top: number };
  contentPositionRef?: React.RefObject<{ left: number; top: number }>;
}

const Dropdown = ({
  disclosure: { isOpen, onClose, toggleOpen },
  onClosed,
  toggleButtonContent,
  toggleButtonProps,
  children,
  contentStyle: style,
  classNames: dropdownClassNames,
  parentContentPosition,
  contentPositionRef,
  ...props
}: DropdownProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentStyle, setContentStyle] = useState<React.CSSProperties>();

  const externalButtonRef = toggleButtonProps?.ref;
  const mergedButtonRef = externalButtonRef || buttonRef;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen && onClosed) {
      onClosed();
    }
  }, [isOpen, onClosed]);

  useLayoutEffect(() => {
    if (
      !isOpen ||
      !mergedButtonRef.current ||
      !containerRef.current ||
      !contentRef.current
    ) {
      return;
    }

    const updatePosition = throttle(() => {
      const buttonRect = mergedButtonRef.current!.getBoundingClientRect();
      const content = contentRef.current!;
      const contentRect = content.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let globalLeft = buttonRect.left;
      let globalTop = buttonRect.bottom;

      if (globalLeft + contentRect.width > viewportWidth) {
        globalLeft = buttonRect.right - contentRect.width;
        if (globalLeft < 0) globalLeft = 0;
      }
      if (globalTop + contentRect.height > viewportHeight) {
        globalTop = buttonRect.top - contentRect.height;
        if (globalTop < 0) globalTop = 0;
      }

      const finalLeft = parentContentPosition
        ? globalLeft - parentContentPosition.left
        : globalLeft;
      const finalTop = parentContentPosition
        ? globalTop - parentContentPosition.top
        : globalTop;

      setContentStyle({
        position: "fixed",
        left: finalLeft,
        top: finalTop,
        minWidth: buttonRect.width,
      });
      if (contentPositionRef && contentPositionRef.current) {
        contentPositionRef.current.left = globalLeft;
        contentPositionRef.current.top = globalTop;
      }
    }, 50);

    updatePosition();
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, contentPositionRef, parentContentPosition, mergedButtonRef]);

  return (
    <div
      ref={containerRef}
      className={classNames("dropdown", dropdownClassNames?.base)}
      {...props}
    >
      {(typeof toggleButtonContent === "string" || toggleButtonContent) && (
        <DropdownButton
          ref={mergedButtonRef}
          {...toggleButtonProps}
          isOpen={isOpen}
          className={dropdownClassNames?.button}
          toggleOpen={toggleOpen}
        >
          {toggleButtonContent}
        </DropdownButton>
      )}
      {isOpen && (
        <div
          className={classNames(
            "dropdown__content",
            dropdownClassNames?.content,
          )}
          style={{ ...style, ...contentStyle }}
          ref={contentRef}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export default Dropdown;
