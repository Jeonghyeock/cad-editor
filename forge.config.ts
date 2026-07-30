import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

import { productName, version } from "./package.json";


const config: ForgeConfig = {
  packagerConfig: {
    // 출력 폴더 이름 — out/CAD Editor-v{version}-{platform}-{arch}/
    // 기본은 package.json 의 name ("cad-editor") 이라 out/cad-editor-win32-x64/ 가 나오는데,
    // 버전 식별을 위해 productName + v{version} 부착.
    name: `${productName}-v${version}`,
    // Create asar archive for main, renderer process files
    asar: true,
    // Set executable name — packagerConfig.name 에 영향 받지 않도록 명시 분리.
    // productName ("CAD Editor") 기준 → CAD Editor.exe.
    executableName: productName,
    // Set application copyright
    appCopyright: "Copyright (C) Jeonghyeock Kim",
    // Set application icon
    icon: "./assets/logo",
    extraResource: [
      "node_modules/occt-import-js/dist/occt-import-js.wasm",
      "node_modules/opencascade.js/dist/opencascade.full.wasm",
    ],
    win32metadata: {
      CompanyName: "Jeonghyeock Kim",
      FileDescription: "CAD Editor Project File",
      OriginalFilename: `${productName}.exe`,
      ProductName: productName,
      InternalName: productName,
    },
    protocols: [
      {
        name: "CAD Editor File",
        schemes: ["cad"],
      },
    ],
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "CAD Editor File",
          CFBundleTypeExtensions: ["cad"],
          CFBundleTypeRole: "Editor",
          LSHandlerRank: "Owner",
        },
      ],
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: productName,
      setupIcon: "./assets/logo.ico",
    }),
    new MakerRpm({}),
    new MakerDeb({
      options: {
        icon: "./assets/logo.png",
        productName,
      },
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({
      format: "ULFO",
      overwrite: true,
      icon: "./assets/logo.icns",
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/app/electrons/main.ts",
          config: "config/vite.main.config.ts",
        },
        {
          entry: "src/app/electrons/preload.ts",
          config: "config/vite.preload.config.ts",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "config/vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
