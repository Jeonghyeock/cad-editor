import classNames from "classnames";
import React from "react";
import type { DetailedHTMLProps } from "react";

import Icon from "../Icon";

interface DropdownItemProps extends DetailedHTMLProps<
  React.HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
> {
  isActive: boolean;
  isIcon?: boolean;
  isDisabled?: boolean;
  children: React.ReactNode;
}

const DropdownItem = ({
  isActive,
  isIcon = true,
  isDisabled = false,
  children,
  className,
  onClick,
  ...props
}: DropdownItemProps) => {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDisabled) return;
    onClick?.(e);
  };

  return (
    <div
      className={classNames(
        "dropdown__content-item",
        isActive && "dropdown__content-item--active",
        isDisabled && "dropdown__content-item--disabled",
        className,
      )}
      onClick={handleClick}
      {...props}
    >
      <Icon.Dot
        style={{ visibility: isActive && isIcon ? "visible" : "hidden" }}
      />
      <p>{children}</p>
    </div>
  );
};

export default DropdownItem;
