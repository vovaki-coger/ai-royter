import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Public runtime configuration for the browser. The Clerk publishable key is
// intentionally readable by anyone; the secret key is never exposed here.
router.get("/config", (_req, res) => {
  res.json({
    clerkPublishableKey:
      process.env.CLERK_PUBLISHABLE_KEY ??
      process.env.VITE_CLERK_PUBLISHABLE_KEY ??
      "",
  });
});

export default router;
