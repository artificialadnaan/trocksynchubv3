import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../server/lib/error-middleware";

/**
 * TRK-2607-H3X6. The handler masked EVERY message in production, including 4xx. That turned
 * body-parser's "request entity too large" into "Internal server error", so the CRM surfaced
 * "RFP delivery failed with 413: Internal server error" — a message that named neither the real
 * cause nor anything the rep could act on. A 4xx describes what the CALLER did wrong and carries
 * no internals, so it must survive; 5xx stays masked.
 */

async function requestError(err: unknown): Promise<{ status: number; body: any }> {
  const app = express();
  app.get("/boom", (_req, _res, next) => next(err));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("errorHandler in production", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = previous;
  });

  it("preserves the reason on a 413 so an oversized body is diagnosable", async () => {
    const result = await requestError(
      Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large" })
    );

    expect(result.status).toBe(413);
    expect(result.body).toEqual({ message: "request entity too large" });
  });

  it("preserves the reason on other client errors", async () => {
    const result = await requestError(Object.assign(new Error("Invalid RFP request signature"), { status: 401 }));

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "Invalid RFP request signature" });
  });

  it("still masks 5xx, which can carry connection details", async () => {
    const result = await requestError(new Error("connect ECONNREFUSED 10.0.0.4:5432 password=hunter2"));

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ message: "Internal server error" });
  });

  it("masks an explicit 5xx status too", async () => {
    const result = await requestError(Object.assign(new Error("upstream Procore token decrypt failed"), { status: 502 }));

    expect(result.status).toBe(502);
    expect(result.body).toEqual({ message: "Internal server error" });
  });
});
