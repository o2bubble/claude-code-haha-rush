/// <reference types="vite/client" />

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "highlight.js/styles/github-dark.min.css";
declare module "highlight.js/styles/github.min.css";
