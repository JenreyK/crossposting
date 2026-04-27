import { Blob as NodeBlob, File as NodeFile } from "node:buffer";

if (typeof globalThis.File === "undefined" && typeof NodeFile !== "undefined") {
  globalThis.File = NodeFile;
}

if (typeof globalThis.Blob === "undefined" && typeof NodeBlob !== "undefined") {
  globalThis.Blob = NodeBlob;
}

await import("./src/index.js");
