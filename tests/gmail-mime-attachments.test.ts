import { describe, expect, it, vi } from "vitest";

// gmail.ts reaches storage at import time via its OAuth helpers; the MIME builder under test is pure.
vi.mock("../server/storage", () => ({
  storage: {
    getAutomationConfig: async () => null,
    upsertAutomationConfig: async () => undefined,
  },
}));

import { buildRawEmail } from "../server/gmail";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

const PDF = Buffer.from("%PDF-1.3\nfake pdf bytes for the test\n");

describe("buildRawEmail without attachments", () => {
  it("is unchanged — still multipart/alternative with a single HTML part", () => {
    const mime = decode(buildRawEmail("to@example.test", "Subject", "<p>hi</p>", "Sender", ["cc@example.test"]));

    expect(mime).toContain("Content-Type: multipart/alternative;");
    expect(mime).not.toContain("multipart/mixed");
    expect(mime).toContain("Cc: cc@example.test");
    expect(mime).toContain("<p>hi</p>");
    expect(mime).not.toContain("Content-Disposition: attachment");
  });
});

describe("buildRawEmail with attachments", () => {
  const build = () =>
    decode(
      buildRawEmail("to@example.test", "Subject", "<p>hi</p>", "Sender", undefined, [
        { filename: "estimates-sent-2026-08-12.pdf", content: PDF, contentType: "application/pdf" },
      ])
    );

  it("switches to multipart/mixed", () => {
    // multipart/alternative means "the same message in different formats", so a client may render one
    // part INSTEAD of the others and is entitled to drop an attachment declared there. mixed is the
    // structure that means "body plus files".
    const mime = build();
    expect(mime).toContain("Content-Type: multipart/mixed;");
    expect(mime).not.toContain("multipart/alternative");
  });

  it("keeps the HTML body alongside the file", () => {
    expect(build()).toContain("<p>hi</p>");
  });

  it("declares the attachment with its filename and type", () => {
    const mime = build();
    expect(mime).toContain('Content-Type: application/pdf; name="estimates-sent-2026-08-12.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="estimates-sent-2026-08-12.pdf"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
  });

  it("round-trips the bytes exactly", () => {
    const mime = build();
    const marker = "Content-Transfer-Encoding: base64\r\n\r\n";
    const body = mime.slice(mime.indexOf(marker) + marker.length);
    const encoded = body.slice(0, body.indexOf("\r\n\r\n")).replace(/\r\n/g, "");
    expect(Buffer.from(encoded, "base64").equals(PDF)).toBe(true);
  });

  it("wraps base64 at 76 characters, which RFC 2045 requires", () => {
    // A single unwrapped multi-KB line is rejected or silently mangled by real MTAs, and a real PDF is
    // far longer than this fixture — so the wrapping is exercised with content that actually needs it.
    const big = Buffer.alloc(5000, 0x41);
    const mime = decode(
      buildRawEmail("to@example.test", "S", "<p>b</p>", undefined, undefined, [
        { filename: "big.pdf", content: big, contentType: "application/pdf" },
      ])
    );
    const marker = "Content-Transfer-Encoding: base64\r\n\r\n";
    const body = mime.slice(mime.indexOf(marker) + marker.length);
    const lines = body.slice(0, body.indexOf("\r\n\r\n")).split("\r\n");

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("closes the multipart envelope", () => {
    const mime = build();
    const boundary = /boundary="([^"]+)"/.exec(mime)![1];
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    // Opening delimiter for the body part, one for the attachment, then the closing one.
    expect(mime.split(`--${boundary}`).length - 1).toBe(3);
  });
});
