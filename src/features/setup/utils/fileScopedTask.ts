/**
 * 비동기 작업이 끝났을 때도 시작한 파일이 활성 파일이면 결과를, 그 사이 다른 파일 탭으로 바뀌었으면 null 을 돌려준다.
 *
 * 결과를 쓰는 setter(setModels 등)는 쓰는 시점의 활성 파일에 쓰고, 명령은 시작할 때 쥔 파일의 이력에 쌓인다.
 * 탭이 바뀐 뒤 결과를 그대로 쓰면 다른 파일에 모델이 들어가고, 시작한 파일에는 실체 없는 이력이 남는다.
 */
export const resolveIfSameFile = async <T>(
  getFileId: () => string,
  task: () => Promise<T>,
): Promise<T | null> => {
  const startFileId = getFileId();
  const result = await task();
  return getFileId() === startFileId ? result : null;
};
