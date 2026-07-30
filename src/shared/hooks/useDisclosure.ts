import { useCallback, useMemo, useState } from "react";

export type Disclosure = {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  toggleOpen: () => void;
  onOpenChange: (open: boolean) => void;
};

export const useDisclosure = (defaultOpen = false): Disclosure => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const onOpen = useCallback(() => {
    setIsOpen(true);
  }, []);

  const onClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const onOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  // return object 를 useMemo 로 안정화. methods 는 useCallback 으로 stable 이지만
  // outer object literal 은 매 render 새 reference 가 됨 — caller 의 useCallback /
  // useMemo deps 에 disclosure 가 들어가면 매 render cascade 가 발생해 무한
  // setState loop (Maximum update depth exceeded) 트리거. isOpen 변경 시에만 새 ref.
  return useMemo(
    () => ({ isOpen, onOpen, onClose, toggleOpen, onOpenChange }),
    [isOpen, onOpen, onClose, toggleOpen, onOpenChange],
  );
};
