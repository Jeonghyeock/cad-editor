import classNames from "classnames";
import React, { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

import Icon from "../Icon";

interface CheckBoxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> {
  icon?: React.ReactNode;
}

const CheckBox = forwardRef<HTMLInputElement, CheckBoxProps>(
  ({ className, icon, checked, onChange, id, ...props }, ref) => {
    return (
      <div className={classNames("checkbox", className)}>
        <input
          id={id}
          type="checkbox"
          name="checkbox"
          ref={ref}
          checked={checked}
          onChange={onChange}
          {...props}
        />
        {checked ? (
          <label htmlFor={id} className="checkbox__checked">
            <Icon.CheckBox />
          </label>
        ) : (
          <label htmlFor={id} className="checkbox__unchecked">
            {icon}
          </label>
        )}
      </div>
    );
  },
);

CheckBox.displayName = "CheckBox";
export default CheckBox;
