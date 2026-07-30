const { execSync } = require("child_process");
const fs = require("fs");

const original = fs.readFileSync("env.config.json", "utf-8");
const config = JSON.parse(original);
config.target = "local";
fs.writeFileSync("env.config.json", JSON.stringify(config, null, 2));

try {
  execSync("electron-forge package", { stdio: "inherit" });
} finally {
  fs.writeFileSync("env.config.json", original);
}
