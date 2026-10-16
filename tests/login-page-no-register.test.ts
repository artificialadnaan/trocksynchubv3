import React from "react";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "../client/src/pages/login";

vi.stubGlobal("React", React);

// The login page's "Need an account? Register" toggle posted to /api/auth/register, which is admin-only (a signed-out
// visitor always got 401). The page is sign-in only now.
describe("login page", () => {
  it("offers sign-in only: no Register toggle, no create-account copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(LoginPage)),
    );
    expect(html).toContain("Sign In");
    expect(html).toContain("Welcome back");
    expect(html).not.toMatch(/Register|Create account|Create Account/);
    expect(html).not.toContain("button-toggle-register");
  });

  it("never posts to the admin-only register endpoint", () => {
    const source = readFileSync(new URL("../client/src/pages/login.tsx", import.meta.url), "utf8");
    expect(source).toContain('apiRequest("POST", "/api/auth/login"');
    expect(source).not.toMatch(/apiRequest\([^)]*\/api\/auth\/register/);
  });
});
