import { app } from "electron";

import fs from "fs";
import path from "path";

const USER_DATA_DIR = app.getPath("userData");
const CONFIG_PATH = path.join(USER_DATA_DIR, "cad-editor.config.json");

class ConfigIpcUtil {
  private static instance: ConfigIpcUtil;

  private constructor() {}

  public static getInstance(): ConfigIpcUtil {
    if (!ConfigIpcUtil.instance) {
      ConfigIpcUtil.instance = new ConfigIpcUtil();
    }
    return ConfigIpcUtil.instance;
  }

  private getConfigPath() {
    return CONFIG_PATH;
  }

  public getConfigFile(): string {
    const configPath = this.getConfigPath();

    try {
      const data = fs.readFileSync(configPath, "utf-8");
      return data;
    } catch {
      return "";
    }
  }

  public saveConfigFile(data: string) {
    const configPath = this.getConfigPath();

    try {
      fs.writeFileSync(configPath, data);
    } catch (error) {
      console.error("Failed to save config file", error);
      return;
    }
  }
}

const configIpcUtil = ConfigIpcUtil.getInstance();

export default configIpcUtil;
