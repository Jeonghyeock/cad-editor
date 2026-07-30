import { useAtom } from "jotai";
import React, { useCallback } from "react";

import Dropdown from "src/components/Dropdown";
import DropdownItem from "src/components/Dropdown/DropdownItem";

import {
  CONFIG_UNIT,
  CONFIG_UNIT_LABEL,
} from "src/shared/constants/Config.constant";
import { useDisclosure } from "src/shared/hooks/useDisclosure";
import { unitAtom } from "src/shared/stores/Config.store";

const AppStatusbar = () => {
  const [unit, setUnit] = useAtom(unitAtom);

  const disclosure = useDisclosure();

  const handleClickUnit = useCallback(
    (nextUnit: keyof typeof CONFIG_UNIT) => () => {
      setUnit(nextUnit);
      disclosure.onClose();
    },
    [disclosure, setUnit],
  );

  return (
    <div id="app-status-bar" className="app-statusbar">
      <div className="app-statusbar__left" />
      <div className="app-statusbar__right">
        <Dropdown
          disclosure={disclosure}
          classNames={{ button: "app-statusbar__unit-toggle" }}
          toggleButtonProps={{ defaultStyle: false }}
          toggleButtonContent={unit}
        >
          {Object.values(CONFIG_UNIT).map((fileUnit) => (
            <DropdownItem
              key={fileUnit}
              isActive={unit === fileUnit}
              onClick={handleClickUnit(fileUnit)}
            >
              {CONFIG_UNIT_LABEL[fileUnit]}
            </DropdownItem>
          ))}
        </Dropdown>
      </div>
    </div>
  );
};

export default AppStatusbar;
