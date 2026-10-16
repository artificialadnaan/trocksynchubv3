import express from "express";
import bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level coverage of two auth P3s (SyncHub BACKLOG):
// - /api/auth/register and /api/auth/login validate their input: a missing or empty username/password is a 400,
//   never a bcrypt throw (500) and never an account with an empty password;
// - login regenerates the session id (no session fixation): the pre-login session is discarded and the user id is
//   written only to the new one.
// Storage is mocked. The session is a fake with express-session's regenerate/save, keyed by an `x-test-session`
// header so the test can see which session object ends up holding the user id.

const usersById = vi.hoisted(() => new Map<string, any>());
const createUserMock = vi.hoisted(() =>
  vi.fn(async (input: any) => {
    // Hashed as storage.createUser does, so an account made here can sign in through the login route.
    const row = { id: `new-${input.username}`, username: input.username, password: await bcrypt.hash(input.password, 4), role: input.role };
    usersById.set(row.id, row);
    return row;
  }),
);

vi.mock("../server/storage.ts", () => ({
  storage: {
    getUser: vi.fn(async (id: string) => usersById.get(id)),
    getUserByUsername: vi.fn(async (username: string) => [...usersById.values()].find((u) => u.username === username)),
    createUser: createUserMock,
  },
}));

type FakeSession = { id: string; userId?: string; req?: any; regenerate: (cb: (err?: unknown) => void) => void; save: (cb: (err?: unknown) => void) => void };
const sessions: Record<string, FakeSession> = {};
let issued = 0;
const regenerated: Array<{ from: string; to: string }> = [];

// The session is bound to the request it is served on (s.req), as express-session's is.
function fakeSession(id: string): FakeSession {
  const s: FakeSession = {
    id,
    regenerate(cb) {
      const fresh = fakeSession(`sid-${++issued}`);
      fresh.req = s.req;
      regenerated.push({ from: s.id, to: fresh.id });
      delete sessions[s.id];
      sessions[fresh.id] = fresh;
      s.req.session = fresh;
      cb();
    },
    save(cb) {
      cb();
    },
  };
  return s;
}

async function withApp(fn: (baseUrl: string) => Promise<void>) {
  const { registerAuthRoutes } = await import("../server/routes/auth.ts");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const sid = req.header("x-test-session");
    req.session = sid ? (sessions[sid] ??= fakeSession(sid)) : fakeSession("anon");
    req.session.req = req;
    next();
  });
  const requireAuth = (req: any, res: any, next: any) => (req.session?.userId ? next() : res.status(401).json({ message: "Unauthorized" }));
  registerAuthRoutes(app, requireAuth);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const post = (baseUrl: string, path: string, body: unknown, sid?: string) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sid ? { "x-test-session": sid } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  vi.resetModules();
  createUserMock.mockClear();
  usersById.clear();
  regenerated.length = 0;
  for (const k of Object.keys(sessions)) delete sessions[k];
  usersById.set("admin-1", { id: "admin-1", username: "boss", password: await bcrypt.hash("right-pw", 4), role: "admin" });
});

describe("POST /api/auth/register input", () => {
  it.each([
    ["no password", { username: "newbie" }],
    ["an empty password", { username: "newbie", password: "" }],
    ["a password that is not a string", { username: "newbie", password: 12345678 }],
    ["no username", { password: "pw-123456" }],
    ["a blank username", { username: "   ", password: "pw-123456" }],
  ])("%s is a 400 and creates nothing", async (_label, body) => {
    sessions.admin = fakeSession("admin");
    sessions.admin.userId = "admin-1";
    await withApp(async (baseUrl) => {
      const res = await post(baseUrl, "/api/auth/register", body, "admin");
      expect(res.status).toBe(400);
      expect(createUserMock).not.toHaveBeenCalled();
    });
  });

  // Codex/CodeRabbit R1: register must store the username exactly as login looks it up, so it is never trimmed.
  it("stores the username exactly as submitted, so the same credentials sign in", async () => {
    sessions.admin = fakeSession("admin");
    sessions.admin.userId = "admin-1";
    await withApp(async (baseUrl) => {
      const res = await post(baseUrl, "/api/auth/register", { username: " alice ", password: "pw-123456" }, "admin");
      expect(res.status).toBe(200);
      expect(createUserMock).toHaveBeenCalledWith({ username: " alice ", password: "pw-123456", role: "user" });
      // ...and the same credentials sign in.
      const login = await post(baseUrl, "/api/auth/login", { username: " alice ", password: "pw-123456" });
      expect(login.status).toBe(200);
      expect((await login.json()).username).toBe(" alice ");
    });
  });

  it("a valid body still creates a least-privileged account", async () => {
    sessions.admin = fakeSession("admin");
    sessions.admin.userId = "admin-1";
    await withApp(async (baseUrl) => {
      const res = await post(baseUrl, "/api/auth/register", { username: "newbie", password: "pw-123456" }, "admin");
      expect(res.status).toBe(200);
      expect(createUserMock).toHaveBeenCalledWith({ username: "newbie", password: "pw-123456", role: "user" });
    });
  });
});

describe("POST /api/auth/login", () => {
  it.each([
    ["no password", { username: "boss" }],
    ["an empty password", { username: "boss", password: "" }],
    ["no username", { password: "right-pw" }],
  ])("%s is a 400 (not a bcrypt 500)", async (_label, body) => {
    await withApp(async (baseUrl) => {
      expect((await post(baseUrl, "/api/auth/login", body)).status).toBe(400);
    });
  });

  it("regenerates the session id: the pre-login session is dropped and only the new one holds the user", async () => {
    sessions.attacker = fakeSession("attacker"); // a session id planted before sign-in
    await withApp(async (baseUrl) => {
      const res = await post(baseUrl, "/api/auth/login", { username: "boss", password: "right-pw" }, "attacker");
      expect(res.status).toBe(200);
      expect(regenerated).toHaveLength(1);
      expect(regenerated[0]!.from).toBe("attacker");
      expect(sessions.attacker).toBeUndefined();
      expect(sessions[regenerated[0]!.to]?.userId).toBe("admin-1");
    });
  });

  it("a wrong password neither signs in nor regenerates", async () => {
    await withApp(async (baseUrl) => {
      expect((await post(baseUrl, "/api/auth/login", { username: "boss", password: "wrong" })).status).toBe(401);
      expect(regenerated).toHaveLength(0);
    });
  });
});
