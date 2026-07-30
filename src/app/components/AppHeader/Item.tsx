import classNames from "classnames";
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useMemo } from "react";

import Icon from "src/components/Icon";

import { useFileActions } from "src/shared/hooks/useFileActions";
import { fileIdAtom, isModifiedAtomFamily } from "src/shared/stores/File.store";
import type { CadFile } from "src/shared/types/File.type";

type ItemProps = {
  file: CadFile;
  width: number;
};

const Item = ({ file, width }: ItemProps) => {
  const fileId = useAtomValue(fileIdAtom);
  const isModified = useAtomValue(isModifiedAtomFamily(file.fileId));

  const isActive = useMemo(() => file.fileId === fileId, [file.fileId, fileId]);

  const { activateFileAction, closeFileAction } = useFileActions();

  const handleItemClick = useCallback(() => {
    if (!isActive) {
      activateFileAction(file.fileId);
    }
  }, [isActive, file.fileId, activateFileAction]);

  const handleCloseFileIpc = useCallback(
    (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
      e.stopPropagation();

      closeFileAction(file.fileId);
    },
    [closeFileAction, file.fileId],
  );

  return (
    <div
      onClick={handleItemClick}
      className={classNames("app-header__files-item", isActive && "active")}
      style={{ width }}
    >
      <div className="app-header__files-item-title">
        <p>{file.fileName}</p>
        {isModified && <span>*</span>}
      </div>
      <button onClick={handleCloseFileIpc}>
        <Icon.Close />
      </button>
    </div>
  );
};

export default memo(Item);
