import { describe, expect, it } from "vitest";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../AnalysisProvider.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderSelectionError } from "../../domain/providerSelectionError.js";
import { err, ok } from "../../domain/result.js";
import {
  NATIVE_DISPATCH_METADATA_SOURCES,
  inspectNativeDispatch,
} from "./NativeDispatchMetadataInspection.js";

const WIDTH_REASON =
  "Unsupported 32-bit Mach-O metadata for requested CPU type arm";

const analysisFailing = (
  binary: AnalysisError,
  symbols: AnalysisError,
): { analysis: AnalysisOperationPort; operations: string[] } => {
  const operations: string[] = [];
  return {
    operations,
    analysis: {
      execute: async (name) => {
        operations.push(name);
        return err(
          name === NATIVE_DISPATCH_METADATA_SOURCES.binary ? binary : symbols,
        );
      },
    },
  };
};

const widthRefusal = (): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    "native-macos",
    NATIVE_DISPATCH_METADATA_SOURCES.binary,
    WIDTH_REASON,
  );

const providerSelectionFailure = (): ProviderSelectionError =>
  new ProviderSelectionError({
    operation: NATIVE_DISPATCH_METADATA_SOURCES.symbols,
    reason: "provider_unavailable",
    requestedProviderId: "auto",
    candidateIds: ["hopper"],
    rejections: [
      {
        providerId: "hopper",
        origin: "availability",
        code: "not_configured",
        reason: "Hopper launcher is missing.",
        diagnostics: { launcher: null },
      },
    ],
  });

describe("native dispatch metadata symbol fallback", () => {
  it.each([
    ["provider selection", providerSelectionFailure],
    [
      "capability",
      () =>
        new AnalysisCapabilityUnavailableError(
          "fixture",
          NATIVE_DISPATCH_METADATA_SOURCES.symbols,
          "symbol inventory is unavailable",
        ),
    ],
  ] as const)(
    "keeps the binary metadata reason when the %s fallback fails",
    async (_, fallbackFailure) => {
      const symbols = fallbackFailure();
      const { analysis, operations } = analysisFailing(widthRefusal(), symbols);

      const result = await inspectNativeDispatch(analysis, 10);

      expect(operations).toEqual([
        NATIVE_DISPATCH_METADATA_SOURCES.binary,
        NATIVE_DISPATCH_METADATA_SOURCES.symbols,
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The alternative's own typed failure stays the returned error.
      expect(result.error).toBe(symbols);
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe(projectAnalysisError(fallbackFailure()).code);
      expect(projected.details?.diagnostics).toEqual({
        binary_metadata_error: projectAnalysisError(widthRefusal()),
      });
      expect(JSON.stringify(projected)).toContain(WIDTH_REASON);
    },
  );

  it("keeps provider readiness details beside the binary metadata reason", async () => {
    const { analysis } = analysisFailing(
      widthRefusal(),
      providerSelectionFailure(),
    );

    const result = await inspectNativeDispatch(analysis, 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const details = projectAnalysisError(result.error).details;
    expect(details).toMatchObject({
      operation: NATIVE_DISPATCH_METADATA_SOURCES.symbols,
      selection_reason: "provider_unavailable",
      rejections: [
        expect.objectContaining({
          provider_id: "hopper",
          origin: "availability",
          code: "not_configured",
        }),
      ],
    });
  });

  it("returns a binary metadata failure that forbids fallback unchanged", async () => {
    const binary = new AnalysisOutputError(
      NATIVE_DISPATCH_METADATA_SOURCES.binary,
      "Invalid native dispatch metadata",
    );
    const { analysis, operations } = analysisFailing(
      binary,
      providerSelectionFailure(),
    );

    const result = await inspectNativeDispatch(analysis, 10);

    expect(operations).toEqual([NATIVE_DISPATCH_METADATA_SOURCES.binary]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(binary);
    expect(result.error.diagnostics).toBeUndefined();
  });

  it("still returns symbol-only coverage when the fallback succeeds", async () => {
    const analysis: AnalysisOperationPort = {
      execute: async (name) =>
        name === NATIVE_DISPATCH_METADATA_SOURCES.binary
          ? err(widthRefusal())
          : ok(
              createAnalysisExecution(
                [{ address: "0x1000", value: "_OBJC_CLASS_$_Widget" }],
                { id: "fixture", name: "Fixture", version: "1" },
              ),
            ),
    };

    const result = await inspectNativeDispatch(analysis, 10);

    expect(result.ok).toBe(true);
  });
});
