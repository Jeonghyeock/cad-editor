import classNames from "classnames";
import React, { forwardRef } from "react";

type AsProp<T extends React.ElementType> = {
  as?: T;
};
type PolymorphicProps<T extends React.ElementType, P> = AsProp<T> &
  Omit<React.ComponentPropsWithoutRef<T>, keyof AsProp<T>> &
  P;

type ButtonProps<T extends React.ElementType = "button"> = PolymorphicProps<
  T,
  {
    children: React.ReactNode;
    variant?: "solid" | "outlined" | "text";
    color?: "default" | "primary";
    radius?: "none" | "md" | "full";
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    disable?: boolean;
    fullWidth?: boolean;
    activeStyle?: boolean;
    disableStyle?: boolean;
    semiDisableStyle?: boolean;
  }
>;

const ButtonBase = forwardRef(
  <T extends React.ElementType = "button">(
    {
      children,
      className,
      as,
      variant = "outlined",
      color = "default",
      radius = "md",
      size = "md",
      disable = false,
      fullWidth = false,
      activeStyle = true,
      disableStyle = false,
      semiDisableStyle = false,
      ...rest
    }: ButtonProps<T>,
    ref: React.Ref<any>, // eslint-disable-line
  ) => {
    const Component = as || "button";

    return (
      <Component
        data-variant={variant}
        data-color={color}
        data-radius={radius}
        data-disabled={disable}
        disabled={disable}
        data-size={size}
        data-active-style={activeStyle}
        data-disable-style={disableStyle}
        data-semi-disable-style={semiDisableStyle}
        data-full-width={fullWidth}
        ref={ref}
        {...(rest as React.ComponentPropsWithoutRef<typeof Component>)}
        className={classNames("button", className)}
      >
        {children}
      </Component>
    );
  },
);

ButtonBase.displayName = "Button";

const Button = ButtonBase as <T extends React.ElementType = "button">(
  props: ButtonProps<T> & { ref?: React.Ref<Element> },
) => React.ReactElement | null;

export default Button;
