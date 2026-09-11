import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AzureDevOpsError, normalizeOrganization } from "../azureDevOpsClient";

describe("normalizeOrganization", () => {
  it("accepts a simple organization name", () => {
    assert.equal(normalizeOrganization(" contoso "), "contoso");
  });

  it("extracts an organization from the canonical URL", () => {
    assert.equal(normalizeOrganization("https://dev.azure.com/contoso/"), "contoso");
  });

  it("rejects unrelated and malformed URLs", () => {
    assert.throws(() => normalizeOrganization("https://example.com/contoso"), AzureDevOpsError);
    assert.throws(() => normalizeOrganization("../contoso"), AzureDevOpsError);
  });
});
