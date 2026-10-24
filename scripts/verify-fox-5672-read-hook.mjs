// Fault injection only for verification; the CLI and production files are unchanged.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalOpen = fs.promises.open;
const opened = new Map();
fs.promises.open = async function (...args) {
  const handle = await originalOpen.apply(this, args);
  const path = String(args[0]);
  const flags = args[1];
  const readOnly =
    flags === "r" ||
    (typeof flags === "number" &&
      (flags &
        (fs.constants.O_WRONLY |
          fs.constants.O_RDWR |
          fs.constants.O_CREAT)) ===
        0);
  if (path.endsWith("/payload") && readOnly) {
    const count = (opened.get(path) ?? 0) + 1;
    opened.set(path, count);
    if (count === 2) {
      const read = handle.read.bind(handle);
      let injected = false;
      handle.read = async (...readArgs) => {
        if (!injected) {
          injected = true;
          process.stderr.write(
            "FOX_PENDING_READ " + process.env.FOX_READ_MODE + "\n",
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (process.env.FOX_READ_MODE === "reject")
            throw Object.assign(new Error("FOX_CONTROLLED_READ_EIO"), {
              code: "EIO",
            });
        }
        return read(...readArgs);
      };
    }
  }
  return handle;
};
syncBuiltinESMExports();
