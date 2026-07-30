import React from "react";

import { MenuChannels } from "src/app/channels/menuChannels";
import type { WindowState } from "src/app/electrons/windowState";

import { useFileActions } from "src/shared/hooks/useFileActions";

// These paths are all drawn to a 10x10 view box and replicate the symbols on Windows controls.
const closePath =
  "M 0,0 0,0.7 4.3,5 0,9.3 0,10 0.7,10 5,5.7 9.3,10 10,10 10,9.3 5.7,5 10,0.7 10,0 9.3,0 5,4.3 0.7,0 Z";
const restorePath =
  "m 2,1e-5 0,2 -2,0 0,8 8,0 0,-2 2,0 0,-8 z m 1,1 6,0 0,6 -1,0 0,-5 -5,0 z m -2,2 6,0 0,6 -6,0 z";
const maximizePath = "M 0,0 0,10 10,10 10,0 Z M 1,1 9,1 9,9 1,9 Z";
const minimizePath = "M 0,5 10,5 10,6 0,6 Z";

type Props = {
  readonly windowState: WindowState;
};

const WindowControls = ({ windowState }: Props) => {
  const { closeWindowAction } = useFileActions();

  const handleWindowMinimize = () => {
    electron.ipcRenderer.invoke(MenuChannels.WINDOW_MINIMIZE, windowState);
  };

  const handleWindowToggleMaximize = () => {
    electron.ipcRenderer.invoke(
      MenuChannels.WINDOW_TOGGLE_MAXIMIZE,
      windowState,
    );
  };

  const handleWindowClose = () => {
    closeWindowAction();
  };

  return (
    <section className="app-titlebar__controls">
      <div
        role="button"
        className="app-titlebar__control"
        onClick={handleWindowMinimize}
        tabIndex={-1}
      >
        <svg aria-hidden="true" version="1.1" width="10" height="10">
          <path fill="currentColor" d={minimizePath} />
        </svg>
      </div>
      <div
        role="button"
        className="app-titlebar__control"
        onClick={handleWindowToggleMaximize}
        tabIndex={-1}
      >
        <svg aria-hidden="true" version="1.1" width="10" height="10">
          <path
            fill="currentColor"
            d={windowState === "maximized" ? restorePath : maximizePath}
          />
        </svg>
      </div>
      <div
        role="button"
        className="app-titlebar__control"
        onClick={handleWindowClose}
        tabIndex={-1}
      >
        <svg aria-hidden="true" version="1.1" width="10" height="10">
          <path fill="currentColor" d={closePath} />
        </svg>
      </div>
    </section>
  );
};

export default WindowControls;
