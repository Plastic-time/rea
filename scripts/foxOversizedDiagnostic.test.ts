import { it, expect } from "vitest";
import { firmwareFixture } from "../../fixtures/firmware/provider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

it("reports the oversized synthetic producer outcome before publication", async () => {
  const fixture = await firmwareFixture("nested-unknown-oversized");
  const result = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
  });
  console.log(
    "FOX_OVERSIZED_DIAGNOSTIC",
    JSON.stringify(
      result.ok ? { ok: true } : projectAnalysisError(result.error),
    ),
  );
  expect(result.ok).toBe(true);
});
