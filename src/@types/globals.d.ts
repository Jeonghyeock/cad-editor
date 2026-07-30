import type { globals } from "src/app/electrons/preload";

declare global {
  const electron: typeof globals;
  const __WIN32__: boolean;
  const __DARWIN__: boolean;
  const __LINUX__: boolean;
  const __APP_NAME__: string;
  const __APP_VERSION__: string;
  const __DEV__: boolean;
}
