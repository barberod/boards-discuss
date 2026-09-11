import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, plainTextFromHtml, sanitizeAzureHtml } from "../security";

describe("webview content security", () => {
  it("escapes plain values before templating", () => {
    assert.equal(escapeHtml(`<img onerror="x">`), "&lt;img onerror=&quot;x&quot;&gt;");
  });

  it("removes active content and dangerous URLs", () => {
    const dirty = `<script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">link</a>`;
    const clean = sanitizeAzureHtml(dirty);
    assert.doesNotMatch(clean, /<script|javascript:|onclick/i);
    assert.match(clean, /rel="noopener noreferrer"/);
  });

  it("creates readable notification previews", () => {
    assert.equal(plainTextFromHtml("<p>Hello <strong>there</strong>&nbsp;&amp; welcome</p>"), "Hello there & welcome");
  });
});
