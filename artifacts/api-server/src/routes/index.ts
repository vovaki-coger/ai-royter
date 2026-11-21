import { Router, type IRouter } from "express";
import aiRouter from "./ai-router";

const router: IRouter = Router();

router.use(aiRouter);

export default router;
