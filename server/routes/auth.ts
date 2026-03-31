import type { Express, RequestHandler } from "express";
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

export function registerAuthRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/auth/login", loginLimiter, asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await storage.getUserByUsername(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username, role: user.role });
  }));

  app.post("/api/auth/register", requireAuth, asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const existing = await storage.getUserByUsername(username);
    if (existing) {
      return res.status(400).json({ message: "Username already exists" });
    }
    const user = await storage.createUser({ username, password });
    req.session.userId = user.id;
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
