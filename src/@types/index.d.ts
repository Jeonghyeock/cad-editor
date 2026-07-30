declare module "*.css";
declare module "*.png";
declare module "*.jpg";
declare module "*.jpeg";
declare module "*.gif";
declare module "*.svg";
declare module "*.scss";

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?raw" {
  const source: string;
  export default source;
}
