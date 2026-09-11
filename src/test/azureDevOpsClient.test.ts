import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AzureDevOpsClient, AzureDevOpsError, normalizeOrganization } from "../azureDevOpsClient";

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

describe("comment API contract", () => {
  it("reads the project-scoped CommentList response", async () => {
    const originalFetch = global.fetch;
    let requestedUrl = "";
    global.fetch = (async (input: string | URL | Request) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({
        count: 1,
        totalCount: 1,
        comments: [{
          id: 7,
          text: "Hello",
          renderedText: "<p>Hello</p>",
          createdBy: { displayName: "Ada" },
          createdDate: "2026-01-01T00:00:00Z"
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const client = new AzureDevOpsClient({ organization: "contoso", project: "", pageSize: 50 }, "secret");
      const comments = await client.getComments(42, "Web Platform");
      assert.equal(comments[0].id, 7);
      assert.match(requestedUrl, /\/Web%20Platform\/_apis\/wit\/workItems\/42\/comments/);
      assert.match(requestedUrl, /api-version=7\.1-preview\.4/);
      assert.match(requestedUrl, /\$expand=renderedText/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
