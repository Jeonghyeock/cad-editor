import React, { useCallback, useEffect, useState } from "react";

import { MenuChannels } from "src/app/channels/menuChannels";
import type { WindowState } from "src/app/electrons/windowState";

import Menu from "./Menu";
import WindowControls from "./WindowControls";

const AppTitlebar = () => {
  const [windowState, setWindowState] = useState<WindowState>("normal");

  useEffect(() => {
    const listener = (_, windowState: WindowState) => {
      setWindowState(windowState);
    };

    electron.ipcRenderer.on("window-state-changed", listener);
    return () => {
      electron.ipcRenderer.removeListener("window-state-changed", listener);
    };
  }, []); // eslint-disable-line

  const handleDoubleClick = useCallback(() => {
    electron.ipcRenderer.invoke(MenuChannels.WINDOW_TOGGLE_MAXIMIZE);
  }, []);

  return (
    <div
      id="app-title-bar"
      onDoubleClick={handleDoubleClick}
      className="app-titlebar"
    >
      {__WIN32__ && (
        <>
          <Menu />
          <div style={{ flex: 1, textAlign: "center", fontWeight: 500 }}>
            CAD Editor v{__APP_VERSION__}
          </div>
          <WindowControls windowState={windowState} />
        </>
      )}
    </div>
  );
};

export default AppTitlebar;
