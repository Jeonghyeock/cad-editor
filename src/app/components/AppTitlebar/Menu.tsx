import { useAtomValue } from "jotai";
import React, { createRef, useMemo, useRef } from "react";

import { MenuChannels } from "src/app/channels/menuChannels";
import { useEventListener } from "src/app/hooks/useEventListener";

import { APP_MENU_OPTIONS } from "src/shared/constants/App.constant";
import { languageAtom } from "src/shared/stores/Config.store";

const getPlatformAcceleratorSymbol = (modifier: string) => {
  switch (modifier.toLowerCase()) {
    case "cmdorctrl":
    case "commandorcontrol":
      return __DARWIN__ ? "⌘" : "Ctrl";

    case "ctrl":
    case "control":
      return __DARWIN__ ? "⌃" : "Ctrl";

    case "shift":
      return __DARWIN__ ? "⇧" : "Shift";
    case "alt":
      return __DARWIN__ ? "⌥" : "Alt";

    // Mac only
    case "cmd":
    case "command":
      return "⌘";
    case "option":
      return "⌥";

    // Special case space because no one would be able to see it
    case " ":
      return "Space";
  }

  // Not a known modifier, likely a normal key
  return modifier;
};

const fixAcceleratorText = (accelerator: Electron.Accelerator) => {
  return accelerator
    .split("+")
    .map(getPlatformAcceleratorSymbol)
    .join(__DARWIN__ ? "" : "+");
};

const Menu = () => {
  const activeMenuIndex = useRef<number | null>(null);
  const currentLanguage = useAtomValue(languageAtom);

  const menusRef = useMemo(
    () => APP_MENU_OPTIONS.map(() => createRef<HTMLDivElement>()),
    [],
  );

  useEventListener("keydown", (event) => handleKeyDown(event));

  useEventListener("mousedown", (event) => handleClickOutside(event));

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.altKey && activeMenuIndex.current) closeActiveMenu();
  };

  const handleClickOutside = (event: MouseEvent) => {
    if (activeMenuIndex.current != null) {
      if (
        menusRef[activeMenuIndex.current].current &&
        !menusRef[activeMenuIndex.current].current?.contains(
          event.target as Node,
        )
      ) {
        closeActiveMenu();
      }
    }
  };

  const showMenu = (
    index: number,
    e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>,
  ) => {
    e.stopPropagation();
    e.preventDefault();

    if (
      menusRef[index].current?.classList.contains(
        "app-titlebar__menu-popup--active",
      )
    ) {
      closeActiveMenu();
    } else {
      menusRef[index].current?.classList.add(
        "app-titlebar__menu-popup--active",
      );
      menusRef[index].current?.parentElement?.classList.add(
        "app-titlebar__menu-item--active",
      );
      activeMenuIndex.current = index;
    }
  };

  const onMenuHover = (index: number) => {
    if (activeMenuIndex.current != null) {
      menusRef[activeMenuIndex.current].current?.classList.toggle(
        "app-titlebar__menu-popup--active",
      );
      menusRef[index].current?.classList.toggle(
        "app-titlebar__menu-popup--active",
      );
      menusRef[index].current?.parentElement?.classList.toggle(
        "app-titlebar__menu-item--active",
      );
      menusRef[
        activeMenuIndex.current
      ].current?.parentElement?.classList.toggle(
        "app-titlebar__menu-item--active",
      );

      activeMenuIndex.current = index;
    }
  };

  const closeActiveMenu = () => {
    if (activeMenuIndex.current != null) {
      menusRef[activeMenuIndex.current].current?.classList.remove(
        "app-titlebar__menu-popup--active",
      );
      menusRef[
        activeMenuIndex.current
      ].current?.parentElement?.classList.remove(
        "app-titlebar__menu-item--active",
      );
      activeMenuIndex.current = null;
    }
  };

  const handleAction = (menuItem: Electron.MenuItemConstructorOptions) => {
    closeActiveMenu();
    const actionId = menuItem.id;
    if (actionId) {
      return electron.ipcRenderer.send(
        MenuChannels.EXECUTE_MENU_ITEM_BY_ID,
        actionId,
      );
    }
  };

  const renderItemAccelerator = (
    menuItem: Electron.MenuItemConstructorOptions,
  ) => {
    if (menuItem.accelerator) {
      return fixAcceleratorText(menuItem.accelerator);
    }
  };

  return (
    <div className="app-titlebar__menu">
      {APP_MENU_OPTIONS.map(({ label, submenu }, menuIndex) => {
        return (
          <div className="app-titlebar__menu-item" key={`menu_${menuIndex}`}>
            <div
              className="app-titlebar__menu-title"
              role="button"
              tabIndex={-1}
              onClick={(e) => showMenu(menuIndex, e)}
              onKeyDown={(e) => showMenu(menuIndex, e)}
              onMouseEnter={() => onMenuHover(menuIndex)}
              onDoubleClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.preventDefault()}
            >
              <p className="text-md">{label}</p>
            </div>
            <div
              className="app-titlebar__menu-popup"
              ref={menusRef[menuIndex]}
            >
              {Array.isArray(submenu) &&
                submenu.map((menuItem, menuItemIndex) => {
                  if (menuItem.type === "separator") {
                    return (
                      <div
                        key={`menu_${menuIndex}_popup_item_${menuItemIndex}`}
                        className="app-titlebar__popup-item-separator"
                      />
                    );
                  }

                  // Language 항목은 radio 의미 — checkable modifier + is-checked 로 CSS ::before
                  // 가 ✓ 렌더. 등폭 폰트 가정 없이 absolute positioning 으로 alignment.
                  const isLangEn = menuItem.id === MenuChannels.SET_LANGUAGE_EN;
                  const isLangKo = menuItem.id === MenuChannels.SET_LANGUAGE_KO;
                  const isCheckable = isLangEn || isLangKo;
                  const isChecked =
                    (isLangEn && currentLanguage === "en") ||
                    (isLangKo && currentLanguage === "ko");
                  const itemClass = `app-titlebar__menu-popup-item${
                    isCheckable ? " app-titlebar__menu-popup-item--checkable" : ""
                  }${isChecked ? " is-checked" : ""}`;
                  return (
                    <div
                      key={`menu_${menuIndex}_popup_item_${menuItemIndex}`}
                      className={itemClass}
                      onMouseDown={(e) => e.preventDefault()}
                      onKeyDown={(e) => e.preventDefault()}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleAction(menuItem)}
                    >
                      <div className="app-titlebar__popup-item-name">
                        {menuItem.label}
                      </div>
                      <div className="app-titlebar__popup-item-shortcut">
                        {renderItemAccelerator(menuItem)}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default Menu;
