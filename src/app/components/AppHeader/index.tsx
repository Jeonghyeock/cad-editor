import { useAtomValue } from "jotai";
import { throttle } from "lodash";
import React, { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import Dropdown from "src/components/Dropdown";
import DropdownItem from "src/components/Dropdown/DropdownItem";
import Icon from "src/components/Icon";

import { APP_PATH } from "src/shared/constants/App.constant";
import { useDisclosure } from "src/shared/hooks/useDisclosure";
import { useFileActions } from "src/shared/hooks/useFileActions";
import { fileIdAtom, openFileListAtom } from "src/shared/stores/File.store";

import Item from "./Item";

const LOGO_WIDTH = 46;
const FILES_DROPDOWN_WIDTH = 40;
const HEADER_ITEM_WIDTH = 199;
const CREATE_BUTTON_WIDTH = 40;

const AppHeader = () => {
  const fileId = useAtomValue(fileIdAtom);
  const openFileList = useAtomValue(openFileListAtom);

  const [filesContainerWidth, setFilesContainerWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(0);
  const [startIndex, setStartIndex] = useState(0);

  const { activateFileAction, createFileAction } = useFileActions();
  const disclosure = useDisclosure();

  const handleDropdownClick = (fileId: string) => () => {
    activateFileAction(fileId);
    disclosure.onClose();
  };

  useEffect(() => {
    const handleResize = throttle(() => {
      const containerWidth =
        window.innerWidth - LOGO_WIDTH - CREATE_BUTTON_WIDTH;
      const count = Math.ceil(containerWidth / HEADER_ITEM_WIDTH) || 1;

      setVisibleCount(count);
      setFilesContainerWidth(containerWidth);
    }, 50);

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    const idx = openFileList.findIndex((file) => file.fileId === fileId);
    if (idx === -1) return;

    const start = idx <= visibleCount - 1 ? 0 : idx - (visibleCount - 1);
    setStartIndex(start);
  }, [visibleCount]); // eslint-disable-line

  useEffect(() => {
    const idx = openFileList.findIndex((file) => file.fileId === fileId);
    const center = Math.floor(visibleCount / 2);
    let start = idx - center;
    if (start < 0) start = 0;

    if (start + visibleCount > openFileList.length) {
      start = Math.max(0, openFileList.length - visibleCount);
    }

    setStartIndex(start);
  }, [fileId, openFileList]); // eslint-disable-line

  return (
    <div className="app-header">
      <Link to={APP_PATH.INPUT} className="app-header__logo">
        <Icon.AppLogo />
      </Link>
      {openFileList.length > visibleCount && (
        <Dropdown
          disclosure={disclosure}
          classNames={{ button: "app-header__files-open-button" }}
          toggleButtonProps={{
            isIcon: true,
            defaultStyle: false,
          }}
          toggleButtonContent={`+${openFileList.length - visibleCount}`}
        >
          {openFileList.map((file) => (
            <DropdownItem
              key={file.fileId}
              onClick={handleDropdownClick(file.fileId)}
              isActive={file.fileId === fileId}
            >
              {file.fileName}
            </DropdownItem>
          ))}
        </Dropdown>
      )}
      <div className="app-header__files-container">
        {openFileList
          .slice(startIndex, startIndex + visibleCount)
          .map((file) => (
            <Item
              key={file.fileId}
              file={file}
              width={
                openFileList.length > visibleCount
                  ? (filesContainerWidth - FILES_DROPDOWN_WIDTH) / visibleCount
                  : openFileList.length === visibleCount
                    ? filesContainerWidth / visibleCount
                    : HEADER_ITEM_WIDTH
              }
            />
          ))}
        <button
          className="app-header__create-file-button"
          style={{
            borderRightStyle:
              openFileList.length >= visibleCount ? "none" : "solid",
          }}
          onClick={createFileAction}
        >
          <Icon.Plus />
        </button>
      </div>
    </div>
  );
};

export default memo(AppHeader);
