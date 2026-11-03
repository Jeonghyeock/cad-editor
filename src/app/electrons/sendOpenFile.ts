import type { WebContents } from "electron";

import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";

/**
 * renderer 에 파일 열기를 보낸다. 로드가 끝났으면 바로 보내고, 로드 중이면 renderer 의 리스너가 붙은 뒤인
 * did-finish-load 에서 한 번만 보낸다. 이미 지나간 이벤트(ready-to-show 등)를 기다리면 영영 보내지 않는다.
 */
export const sendOpenFile = (
  webContents: Pick<WebContents, "isLoading" | "once" | "send">,
  filePath: string,
) => {
  const send = () =>
    webContents.send(MenuChannels.MENU_EVENT, FileChannels.OPEN_FILE, filePath);

  if (webContents.isLoading()) {
    webContents.once("did-finish-load", send);
  } else {
    send();
  }
};
