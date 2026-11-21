import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Public runtime configuration for the browser. These values are safe to
// expose: they are publishable keys / URLs, never secret keys.
router.get("/config", (_req, res) => {
  res.json({
    authProvider: "supabase",
    supabaseUrl: process.env.SUPABASE_URL ?? "",
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
    clerkPublishableKey:
      process.env.CLERK_PUBLISHABLE_KEY ??
      process.env.VITE_CLERK_PUBLISHABLE_KEY ??
      "",
  });
});

export default router;
