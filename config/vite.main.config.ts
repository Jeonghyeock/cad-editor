import type { ConfigEnv, UserConfig } from "vite";
import { defineConfig, mergeConfig } from "vite";
import { checker } from "vite-plugin-checker";
import viteTsconfigPaths from "vite-tsconfig-paths";
import {
  getBuildConfig,
  getBuildDefine,
  external,
  pluginHotRestart,
} from "./vite.base.config";

// https://vitejs.dev/config
export default defineConfig((env) => {
  const forgeEnv = env as ConfigEnv<"build">;
  const { forgeConfigSelf } = forgeEnv;
  const define = getBuildDefine(forgeEnv);
  const config: UserConfig = {
    build: {
      lib: {
        entry: forgeConfigSelf.entry,
        fileName: () => "[name].js",
        formats: ["cjs"],
      },
      rollupOptions: {
        external,
      },
    },
    plugins: [
      pluginHotRestart("restart"),
      viteTsconfigPaths(),
      checker({
        typescript: true,
        eslint: {
          // src/만 검사 — config/ / packages/ 같은 외부 코드는 제외.
          lintCommand: 'eslint "src/**/*.{ts,tsx}"',
          dev: {
            logLevel: ["error"],
          },
        },
      }),
    ],
    define,
    resolve: {
      // Load the Node.js entry.
      mainFields: ["module", "jsnext:main", "jsnext"],
    },
  };

  return mergeConfig(getBuildConfig(forgeEnv), config);
});
