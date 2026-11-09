import express from "express";
import cors from "cors";
import { SendTheEffect } from "./random.js";

export class GoalHandler {
    constructor(effectDataBase, wsServer, GCE) {
        this.app = express();
        this.port = 8892;

        this.effectDataBase = effectDataBase;
        this.wsServer = wsServer;
        this.GCE = this.normalizeGoalConfig(GCE);
        this.effects = this.parseEffects(effectDataBase);

        this.app.use(
            cors({
                origin: "*",
                methods: "*",
                allowedHeaders: "*",
                exposedHeaders: "*",
            })
        );

        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        this.app.use("/api", this.handleAPIRoutes());

        this.app.use((err, req, res, next) => {
            console.log("Internal Error: ", err);
            res.json({ message: "API: " + err.message });
        });

        this.app.get("/", (req, res) => {
            res.send("So.... you're looking for something?");
        });

        this.app.listen(this.port, () => {
            console.log(`Server is running on port ${this.port}`);
        });
        
        console.log("This Chaos has Goal Action Activated, you can add this to indofinity / Tikfinity.");
        console.log("Pusat Interaksi > + Interaksi > Trigger Webhook > http://localhost:8892/api/features/actions/exec");
        if (this.GCE.goals.length > 0) {
            this.GCE.goals.forEach((goal) => {
                console.log(`[Goal] ${goal.name} webhook: http://localhost:8892/api/features/actions/exec?goal=${goal.key}`);
            });
        }
    }

    parseEffects(effectDataBase) {
        try {
            let parsed = JSON.parse(effectDataBase);
            return parsed["Function"] || [];
        } catch (error) {
            return [];
        }
    }

    updateEffectDataBase(effectDataBase) {
        this.effectDataBase = effectDataBase;
        this.effects = this.parseEffects(effectDataBase);
    }

    updateGoalConfig(GCE) {
        this.GCE = this.normalizeGoalConfig(GCE);
    }

    toGoalKey(value, fallbackIndex = 1) {
        let normalized = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return normalized || `goal-${fallbackIndex}`;
    }

    normalizeGoalConfig(rawGoalConfig) {
        let rawGoals = [];

        if (rawGoalConfig && Array.isArray(rawGoalConfig.goals)) {
            rawGoals = rawGoalConfig.goals;
        } else if (rawGoalConfig && rawGoalConfig.id) {
            rawGoals = [
                {
                    name: rawGoalConfig.name || "Goal 1",
                    key: rawGoalConfig.key || "goal-1",
                    id: rawGoalConfig.id,
                    effect: rawGoalConfig.effect || "",
                },
            ];
        }

        let usedKeys = new Set();
        let goals = rawGoals
            .filter((goal) => goal && typeof goal === "object")
            .map((goal, index) => {
                let id = String(goal.id || goal.effect_id || "").trim();
                if (id === "") {
                    return null;
                }

                let name = String(goal.name || "").trim();
                if (name === "") {
                    name = `Goal ${index + 1}`;
                }

                let keyBase = this.toGoalKey(goal.key || goal.slug || name, index + 1);
                let key = keyBase;
                let suffix = 2;
                while (usedKeys.has(key)) {
                    key = `${keyBase}-${suffix}`;
                    suffix++;
                }
                usedKeys.add(key);

                return {
                    name,
                    key,
                    id,
                    effect: String(goal.effect || "").trim(),
                };
            })
            .filter((goal) => goal != null);

        let firstGoal = goals[0];
        return {
            goals,
            id: firstGoal ? firstGoal.id : "",
            effect: firstGoal ? firstGoal.effect : "",
        };
    }

    getGoalFromRequest(req) {
        let requestedGoal = String(req.query.goal || req.query.key || req.query.goalKey || "").trim();
        let requestedGoalIndex = req.query.goalIndex;

        if (requestedGoal.toLowerCase() === "all") {
            return "all";
        }

        if (requestedGoal !== "") {
            let foundByKey = this.GCE.goals.find(
                (goal) => goal.key === requestedGoal || goal.id === requestedGoal,
            );
            if (!foundByKey) {
                return null;
            }
            return foundByKey;
        }

        if (requestedGoalIndex != undefined) {
            let parsedIndex = parseInt(requestedGoalIndex, 10);
            if (Number.isNaN(parsedIndex) || parsedIndex < 1 || parsedIndex > this.GCE.goals.length) {
                return null;
            }
            return this.GCE.goals[parsedIndex - 1];
        }

        return this.GCE.goals[0] || null;
    }

    runGoal(goal, context = {}) {
        if (!goal || !goal.id) {
            return { success: false, message: "[Goal] Action not found!" };
        }

        let targetId = String(goal.id || "").trim().toLowerCase();
        let effect = this.effects.find((x) => String(x.id || "").toLowerCase() === targetId);

        if (!effect) {
            // Fallback 1: Cocokkan berdasarkan nama atau deskripsi
            effect = this.effects.find(
                (x) =>
                    String(x.name || "").toLowerCase() === targetId ||
                    String(x.description || "").toLowerCase() === targetId ||
                    String(x.name || "").toLowerCase() === String(goal.effect || "").toLowerCase() ||
                    String(x.description || "").toLowerCase() === String(goal.effect || "").toLowerCase()
            );
        }

        // Fallback 2: Safe Payload Builder agar efek goal tetap terkirim ke server game
        if (!effect) {
            effect = {
                id: goal.id,
                name: goal.effect || goal.name || `Goal Effect ${goal.id}`,
                description: goal.effect || goal.id,
                category: "Goal",
            };
            console.log(`[Goal] Effect not found in local list for ${goal.name}, using safe payload:`, effect);
        } else {
            console.log(`[Goal] Effect Found for ${goal.name}:`, effect);
        }

        let uniqueId = context.userId || context.uniqueId || "";
        let nickname = context.username || context.nickname || "";

        let payload = {
            ...effect,
            id: "effect_" + effect.id,
            uniqueId: uniqueId,
            uniqueID: uniqueId,
            nickname: nickname,
            username: nickname || uniqueId,
            user: { uniqueId, nickname },
            subtext: nickname || uniqueId,
        };

        if (global.TiktokHandler && typeof global.TiktokHandler.sendEffectToClients === "function") {
            global.TiktokHandler.sendEffectToClients(payload);
        } else {
            this.wsServer.clients.forEach((clients) => {
                let edata = SendTheEffect(payload, global.userSeed, global.rngInstance);
                clients.send(JSON.stringify(edata));
            });
        }

        return {
            success: true,
            goal: goal,
            effect: effect,
        };
    }

    handleAPIRoutes() {
        let router = express.Router();

        router.get("/", (req, res) => {
            res.send("API is running!");
        });

        router.use("/features", this.handleFeatureRoutes());

        return router;
    }

    handleFeatureRoutes() {
        let router = express.Router();

        router.post(
            "/actions/exec",
            (req, res) => {
                if (this.GCE.goals.length === 0) {
                    return res.status(404).json({
                        message: "[Goal] No goal action configured!",
                    });
                }

                let context = req.body.context || req.body || {};
                let selectedGoal = this.getGoalFromRequest(req);
                if (selectedGoal === "all") {
                    let executedGoals = [];

                    this.GCE.goals.forEach((goal) => {
                        let result = this.runGoal(goal, context);
                        if (result.success) {
                            executedGoals.push({
                                name: goal.name,
                                key: goal.key,
                                effectId: result.effect.id,
                                effectName: result.effect.name,
                            });
                        }
                    });

                    if (executedGoals.length === 0) {
                        return res.status(404).json({
                            message: "[Goal] No valid goal actions found!",
                        });
                    }

                    return res.json({
                        message: "[Goal] All goal actions executed!",
                        goals: executedGoals,
                    });
                }

                if (!selectedGoal) {
                    return res.status(404).json({
                        message: "[Goal] Goal key not found!",
                        availableGoals: this.GCE.goals.map((goal) => {
                            return {
                                name: goal.name,
                                key: goal.key,
                            };
                        }),
                    });
                }

                let result = this.runGoal(selectedGoal, context);
                if (!result.success) {
                    return res.status(404).json({
                        message: result.message,
                    });
                }

                return res.json({
                    message: "[Goal] Action executed!",
                    goal: {
                        name: result.goal.name,
                        key: result.goal.key,
                    },
                    effect: {
                        id: result.effect.id,
                        name: result.effect.name,
                    },
                });
            }
        );

        router.get("/", (req, res) => {
            res.send("Feature API is running!");
        });

        return router;
    }
}

export class Goal extends GoalHandler {
    constructor(effectDataBase, wsServer, GCE) {
        super(effectDataBase, wsServer, GCE);
    }
}