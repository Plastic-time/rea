import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../../src/application/AnalysisProvider.js";
import { inspectNativeDispatch } from "../../../../src/application/native/NativeDispatchMetadataInspection.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ProviderSelectionError } from "../../../../src/domain/providerSelectionError.js";
import { err, ok } from "../../../../src/domain/result.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { NativeFixtureRunner } from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

/** A complete thin armv7 header with one __TEXT segment. */
const thin32ArmMachO = (): Buffer => {
  const bytes = Buffer.alloc(84);
  bytes.writeUInt32LE(0xfeedface, 0);
  bytes.writeUInt32LE(12, 4); // CPU_TYPE_ARM
  bytes.writeUInt32LE(9, 8); // CPU_SUBTYPE_ARM_V7
  bytes.writeUInt32LE(2, 12); // MH_EXECUTE
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(56, 20);
  bytes.writeUInt32LE(1, 28); // LC_SEGMENT
  bytes.writeUInt32LE(56, 32);
  bytes.write("__TEXT", 36);
  bytes.writeUInt32LE(0x1000, 52);
  bytes.writeUInt32LE(0x1000, 56);
  bytes.writeUInt32LE(0, 60);
  bytes.writeUInt32LE(bytes.length, 64);
  bytes.writeUInt32LE(7, 68);
  bytes.writeUInt32LE(5, 72);
  return bytes;
};

it.each(["unavailable", "malformed"] as const)(
  "keeps the binary reader's refusal when an %s symbol fallback fails",
  async (fallback) => {
    const root = await createTestTempDirectory("rea-dispatch-fallback-");
    const path = join(root, "fixture");
    const bytes = thin32ArmMachO();
    await writeFile(path, bytes);
    const target = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "executable" as const,
      format: "mach-o" as const,
      architecture: "arm" as const,
      availableArchitectures: ["arm" as const],
    };
    const reader = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner(),
      "darwin",
    ).createClient(target);
    const analysis: AnalysisOperationPort = {
      execute: async (operation, parameters, options) => {
        if (operation !== "list_names")
          return reader.execute(operation, parameters, options);
        return fallback === "unavailable"
          ? err(
              new ProviderSelectionError({
                operation,
                reason: "provider_unavailable",
                requestedProviderId: "auto",
                candidateIds: ["hopper", "ghidra"],
              }),
            )
          : ok(
              createAnalysisExecution(
                { not: "an inventory" },
                { id: "hopper", name: "Hopper", version: "1" },
              ),
            );
      },
    };
    try {
      const result = await inspectNativeDispatch(analysis, 10);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The fallback's own failure stays primary; the reader's reason is kept.
      expect(projectAnalysisError(result.error)).toMatchObject({
        code:
          fallback === "unavailable"
            ? "provider_unavailable"
            : "unreadable_output",
        details: {
          diagnostics: {
            binary_metadata_error: {
              code: "capability_unavailable",
              details: {
                operation: "inspect_native_dispatch_metadata",
                reason: expect.stringContaining(
                  "Unsupported 32-bit Mach-O metadata",
                ),
              },
            },
          },
        },
      });
    } finally {
      expect(await reader.close()).toMatchObject({ ok: true });
    }
  },
);
