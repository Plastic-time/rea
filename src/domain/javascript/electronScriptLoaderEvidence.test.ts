import { expect, it } from "vitest";

import {
  hasElectronRendererEvidence,
  mayRunUnderElectronScriptLoader,
} from "./electronScriptLoaderEvidence.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const parse = (...input: Parameters<typeof parseJavaScriptSource>) => {
  const parsed = parseJavaScriptSource(...input);
  if (parsed === null) throw new Error("Expected parsed source");
  return parsed;
};

it.each([
  [
    'const { ipcRenderer } = require("electron");',
    "preload.js",
    "module",
    true,
  ],
  ['require("electron/renderer");', "preload.ts", "module", true],
  ['void (() => require("electron"));', "preload.js", "module", true],
  ['const dependency = require("./dep.cjs");', "main.js", "module", false],
  ['const store = require("electron-store");', "main.js", "module", false],
  ['import "./setup.js"; require("electron");', "main.js", "module", false],
  ['require("electron");', "preload.mjs", "module", false],
  ['require("electron");', "preload.js", "commonjs", false],
  ['require("electron");', "preload.js", undefined, false],
] as const)(
  "selects package-module scripts that require Electron: %s (%s, %s)",
  (source, path, packageType, expected) => {
    expect(
      mayRunUnderElectronScriptLoader(parse(source, path, packageType).program),
    ).toBe(expected);
  },
);

it.each([
  [
    "a destructured contextBridge exposure",
    'const { contextBridge } = require("electron");\ncontextBridge.exposeInMainWorld("api", {});',
    true,
  ],
  [
    "a direct ipcRenderer send",
    'require("electron").ipcRenderer.send("ready");',
    true,
  ],
  [
    "a renderer IPC listener",
    'const { ipcRenderer } = require("electron");\nipcRenderer.on("update", () => {});',
    true,
  ],
  [
    "main-process IPC only",
    'const { app, ipcMain } = require("electron");\nipcMain.handle("ping", () => app.getName());',
    false,
  ],
  ["no Electron operation", 'require("electron");', false],
  [
    "a locally bound require",
    'function load(require) {\n  require("electron").contextBridge.exposeInMainWorld("api", {});\n}',
    false,
  ],
] as const)(
  "reads renderer-side Electron evidence from %s",
  (_name, source, expected) => {
    const parsed = parse(source, "preload.js");
    const { electron } = analyzeParsedJavaScriptStaticSource(source, parsed);
    expect(hasElectronRendererEvidence(electron)).toBe(expected);
  },
);
