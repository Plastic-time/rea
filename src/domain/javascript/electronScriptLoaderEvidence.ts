import * as t from "@babel/types";

import type { ElectronStaticFindings } from "./electronStaticAnalysisTypes.js";
import { ELECTRON_MODULE } from "./javascriptElectronMemberWrites.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";

/**
 * Whether a script owes its module context only to a `"type": "module"`
 * package scope and requires an Electron module. Electron's preload loader
 * ignores that package type and gives a .js preload `require`; ESM preloads
 * need the .mjs suffix ("ES Modules (ESM) in Electron"). The call alone is not
 * evidence of that loader: Node's ESM loader, which the main process uses,
 * has no `require`, so the same call there throws. Module syntax would make
 * the source a module under every loader, so only scripts qualify.
 */
export const mayRunUnderElectronScriptLoader = (
  program: t.Program,
): boolean => {
  if (
    javaScriptRuntimeContext(program) !== "module" ||
    program.sourceType !== "script"
  )
    return false;
  let found = false;
  traverseJavaScriptAst(program, {
    skip: () => found,
    enter: (node) => {
      found ||=
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "require" }) &&
        t.isStringLiteral(node.arguments[0]) &&
        ELECTRON_MODULE.test(node.arguments[0].value);
    },
  });
  return found;
};

/**
 * `contextBridge` and `ipcRenderer` are renderer-process Electron modules; the
 * main process cannot obtain them. A directly observed exposure or renderer
 * IPC operation therefore places its source under a renderer-side loader.
 * Wrapper substitutions are inferred, so they do not count.
 */
export const hasElectronRendererEvidence = (
  electron: ElectronStaticFindings,
): boolean =>
  electron.context_bridge_apis.some(
    ({ resolution_basis }) => resolution_basis === undefined,
  ) ||
  electron.ipc.some(
    ({ side, resolution_basis }) =>
      side === "renderer" && resolution_basis === undefined,
  );
