import { expect, it } from "vitest";

import {
  electronRendererEvidenceSteps,
  mayRunUnderElectronScriptLoader,
} from "./electronScriptLoaderEvidence.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
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
  ['require("electron/renderer").contextBridge;', "preload.ts", "module", true],
  [
    'void (() => require("electron")["ipcRenderer"]);',
    "preload.js",
    "module",
    true,
  ],
  ["require(`electron`)[`ipcRenderer`];", "preload.js", "module", true],
  ['require("electron");', "main.js", "module", false],
  [
    'const { app, BrowserWindow } = require("electron");',
    "main.js",
    "module",
    false,
  ],
  ['const ipcRenderer = require("./dep.cjs");', "main.js", "module", false],
  [
    'const store = require("electron-store"); store.ipcRenderer;',
    "main.js",
    "module",
    false,
  ],
  [
    'import "./setup.js"; require("electron").ipcRenderer;',
    "main.js",
    "module",
    false,
  ],
  ['require("electron").ipcRenderer;', "preload.mjs", "module", false],
  ['require("electron").ipcRenderer;', "preload.js", "commonjs", false],
  ['require("electron").ipcRenderer;', "preload.js", undefined, false],
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
    "a template-literal specifier",
    'require(`electron`).ipcRenderer.send("ready");',
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
    expect(
      completeSemanticSteps(electronRendererEvidenceSteps(parsed.program)),
    ).toBe(expected);
    // The focused check agrees with the full static pass's direct findings.
    const { electron } = analyzeParsedJavaScriptStaticSource(source, parsed);
    expect(
      electron.context_bridge_apis.some(
        ({ resolution_basis }) => resolution_basis === undefined,
      ) ||
        electron.ipc.some(
          ({ side, resolution_basis }) =>
            side === "renderer" && resolution_basis === undefined,
        ),
    ).toBe(expected);
  },
);
