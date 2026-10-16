import type { Express, Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import bcrypt from "bcrypt";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 attempts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

/** Role given to every account created through /api/auth/register. Never "admin". */
export const LEAST_PRIVILEGED_ROLE = "user";

/** A non-empty string after trimming, or null. Request bodies are untrusted: a missing field must not reach bcrypt. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * A fresh session id at login (no session fixation): whatever id the browser held before signing in is discarded,
 * and the user id is written to the new session only. Resolves once the new session is saved.
 */
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

export function registerAuthRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/auth/login", loginLimiter, asyncHandler(async (req, res) => {
    const username = nonEmptyString(req.body?.username);
    const password = nonEmptyString(req.body?.password);
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }
    const user = await storage.getUserByUsername(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);
    res.json({ id: user.id, username: user.username, role: user.role });
  }));

  // Account creation is admin-only. The caller must be an existing user whose role is "admin";
  // the new account is always created with the least-privileged role (the users.role column
  // defaults to "admin", so the role is passed explicitly), and the caller's session is left
  // untouched -- the admin stays logged in as themselves.
  app.post("/api/auth/register", requireAuth, asyncHandler(async (req, res) => {
    const caller = await storage.getUser(req.session.userId!);
    if (!caller || caller.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    // Stored exactly as submitted (as login looks it up): a blank name is refused, nothing is normalized.
    const username = nonEmptyString(req.body?.username);
    const password = nonEmptyString(req.body?.password);
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }
    const existing = await storage.getUserByUsername(username);
    if (existing) {
      return res.status(400).json({ message: "Username already exists" });
    }
    const user = await storage.createUser({ username, password, role: LEAST_PRIVILEGED_ROLE });
    res.json({ id: user.id, username: user.username, role: user.role });
  }));

  app.get("/api/auth/me", asyncHandler(async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    res.json({ id: user.id, username: user.username, role: user.role });
  }));

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ message: "Logged out" });
    });
  });
}
