import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level coverage of POST /api/auth/register. Storage is fully mocked; the session is a
// plain in-memory object keyed by an `x-test-session` header, and requireAuth mirrors the real
// one in server/routes/index.ts (401 unless req.session.userId is set).
//
// Regression for: any logged-in user could call register, the new account took the users.role
// column default ("admin"), and the route then swapped the caller's session onto the new account.

const usersById = vi.hoisted(() => new Map<string, any>());
const createUserMock = vi.hoisted(() =>
  vi.fn(async (input: any) => {
    const row = { id: `new-${input.username}`, username: input.username, password: "hashed", role: input.role ?? "admin" };
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

const sessions: Record<string, any> = {};

async function withApp(fn: (baseUrl: string) => Promise<void>) {
  const { registerAuthRoutes } = await import("../server/routes/auth.ts");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const sid = req.header("x-test-session");
    req.session = sid ? (sessions[sid] ??= {}) : {};
    next();
  });
  const requireAuth = (req: any, res: any, next: any) => {
    if (req.session?.userId) return next();
    res.status(401).json({ message: "Unauthorized" });
  };
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

function register(baseUrl: string, sid: string | null, body: any = { username: "newbie", password: "pw-123456" }) {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sid ? { "x-test-session": sid } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.resetModules();
    createUserMock.mockClear();
    usersById.clear();
    for (const k of Object.keys(sessions)) delete sessions[k];
    usersById.set("admin-1", { id: "admin-1", username: "boss", password: "x", role: "admin" });
    usersById.set("user-1", { id: "user-1", username: "staff", password: "x", role: "user" });
    sessions.admin = { userId: "admin-1" };
    sessions.nonadmin = { userId: "user-1" };
  });

  it("(a) an existing admin can create an account", async () => {
    await withApp(async (baseUrl) => {
      const res = await register(baseUrl, "admin");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.username).toBe("newbie");
      expect(createUserMock).toHaveBeenCalledTimes(1);
    });
  });

  it("(b) the new account gets the least-privileged role, never the 'admin' column default", async () => {
    await withApp(async (baseUrl) => {
      // Even a body that asks for admin is ignored: the route has no role field.
      const res = await register(baseUrl, "admin", { username: "newbie", password: "pw-123456", role: "admin" });
      expect(res.status).toBe(200);
      expect(createUserMock).toHaveBeenCalledWith({ username: "newbie", password: "pw-123456", role: "user" });
      expect((await res.json()).role).toBe("user");
    });
  });

  it("(c) the caller's session is not swapped onto the new account", async () => {
    await withApp(async (baseUrl) => {
      const res = await register(baseUrl, "admin");
      expect(res.status).toBe(200);
      expect(sessions.admin.userId).toBe("admin-1");
    });
  });

  it("refuses a logged-in non-admin with 403 and creates nothing", async () => {
    await withApp(async (baseUrl) => {
      const res = await register(baseUrl, "nonadmin");
      expect(res.status).toBe(403);
      expect(createUserMock).not.toHaveBeenCalled();
      expect(sessions.nonadmin.userId).toBe("user-1");
    });
  });

  it("refuses an unauthenticated caller with 401 and creates nothing", async () => {
    await withApp(async (baseUrl) => {
      const res = await register(baseUrl, null);
      expect(res.status).toBe(401);
      expect(createUserMock).not.toHaveBeenCalled();
    });
  });

  it("refuses a session whose user no longer exists with 403", async () => {
    sessions.ghost = { userId: "deleted-user" };
    await withApp(async (baseUrl) => {
      const res = await register(baseUrl, "ghost");
      expect(res.status).toBe(403);
      expect(createUserMock).not.toHaveBeenCalled();
    });
  });
});
