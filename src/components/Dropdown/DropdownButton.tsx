import classNames from "classnames";
import React, { forwardRef } from "react";

import Icon from "../Icon";

type AsProp<T extends React.ElementType> = {
  as?: T;
};
type PolymorphicProps<T extends React.ElementType, P> = AsProp<T> &
  Omit<React.ComponentPropsWithoutRef<T>, keyof AsProp<T>> &
  P;

export type DropdownButtonProps = PolymorphicProps<
  React.ElementType,
  {
    isOpen: boolean;
    toggleOpen: () => void;
    children: React.ReactNode;
    className?: string;
    isIcon?: boolean;
    isReverse?: boolean;
    isIconReverse?: boolean;
    defaultStyle?: boolean;
  }
>;

const DropdownButton = forwardRef<HTMLButtonElement, DropdownButtonProps>(
  (
    {
      isOpen,
      toggleOpen,
      children,
      className,
      isIcon = true,
      isReverse = false,
      isIconReverse = false,
      defaultStyle = true,
      as,
      ...rest
    },
    ref,
  ) => {
    const Component = as || "button";

    return (
      <Component
        ref={ref}
        {...rest}
        className={classNames(
          "dropdown__button",
          defaultStyle && "dropdown__button--default",
          isReverse && "dropdown__button--reverse",
          className,
        )}
        onClick={toggleOpen}
      >
        {children}
        {isIcon &&
          ((isOpen && !isIconReverse) || (!isOpen && isIconReverse) ? (
            <Icon.TriangleDropup />
          ) : (
            <Icon.TriangleDropdown />
          ))}
      </Component>
    );
  },
);

DropdownButton.displayName = "DropdownButton";

export default DropdownButton;
