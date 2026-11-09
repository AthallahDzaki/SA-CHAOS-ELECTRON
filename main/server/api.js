import express from "express";
import cors from "cors";
import { SendTheEffect } from "./random.js";

export class APIHandler {
    constructor(effectDataBase, wsServer) {
        this.app = express();
        this.port = 8832;

        this.effectDataBase = effectDataBase;
        this.wsServer = wsServer;

        this.app.use(
            cors({
                origin: "*",
                methods: "*",
                allowedHeaders: "*",
                exposedHeaders: "*",
            })
        );

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
    }

    updateEffectDataBase(effectDataBase) {
        this.effectDataBase = effectDataBase;
    }

    handleAPIRoutes() {
        let router = express.Router();

        router.get("/", (req, res) => {
            res.send("API is running!");
        });

        router.get("/app/info", (req, res) => {
            res.json({
                data: {
                    author: "@athallahdzaki",
                    name: "GTA-SA Chaos",
                    version: "1.0.0",
                },
            });
        });

        router.use("/features", this.handleFeatureRoutes());

        return router;
    }

    handleFeatureRoutes() {
        let router = express.Router();

        router.get("/categories", (req, res) => {
            let effects = JSON.parse(this.effectDataBase)["Function"];
            let categories = [];
            // Example : {
            //     categoryId: effect.category,
            //     categoryName: effect.category,
            // }

            effects.forEach((effect) => {
                if (
                    categories.find((x) => x.categoryId == effect.category) ==
                        undefined &&
                    !this.UnsupportedEffectCategory.includes(effect.category)
                ) {
                    categories.push({
                        categoryId: effect.category,
                        categoryName: effect.category,
                    });
                }
            });
            res.json({ data: categories });
        });

        router.get("/actions", (req, res) => {
            if (req.query.categoryId == undefined) {
                res.status(400).json({
                    message: "[API] Category is not defined!",
                });
                return;
            }
            if (req.query.categoryId == "") {
                res.status(400).json({ message: "[API] Category is empty!" });
                return;
            }
            let effects = JSON.parse(this.effectDataBase)["Function"];
            let actions = [];

            effects.forEach((effect) => {
                if (
                    effect.category.toLowerCase() ==
                    req.query.categoryId.toLowerCase()
                ) {
                    // Skip Exclusive Effect
                    actions.push({
                        actionId: effect.id,
                        actionName: effect.name,
                    });
                }
            });

            res.json({ data: actions });
        });

        router.post(
            "/actions/exec",
            express.json({ type: "*/*" }),
            (req, res) => {
                /*
            {
                "categoryId":"smart_device_control",
                "actionId":"turn_lights_on",
                "context":{
                    "triggerTypeId": 3,
                    "userId": "123456789",
                    "username": "Tesuser",
                    "coins": 12
                }
            }
            */
                if (
                    req.body.categoryId == undefined ||
                    req.body.actionId == undefined
                ) {
                    res.status(400).json({
                        message: "[API] Category or Action is not defined!",
                    });
                    return;
                }

                if (req.body.categoryId == "" || req.body.actionId == "") {
                    res.status(400).json({
                        message: "[API] Category or Action is empty!",
                    });
                    return;
                }

                console.log("[API] Executing Action: ", req.body);

                let effects = [];
                try {
                    let parsed = typeof this.effectDataBase === "string" ? JSON.parse(this.effectDataBase) : this.effectDataBase;
                    effects = Array.isArray(parsed?.Function) ? parsed.Function : [];
                } catch (e) {
                    effects = [];
                }

                let targetActionId = String(req.body.actionId || "").trim().toLowerCase();
                let targetCategoryId = String(req.body.categoryId || "").trim().toLowerCase();

                let effect = effects.find(
                    (x) =>
                        String(x.id || "").toLowerCase() == targetActionId &&
                        String(x.category || "").toLowerCase() == targetCategoryId
                );

                if (!effect) {
                    // Fallback 1: Cocokkan berdasarkan ID saja
                    effect = effects.find((x) => String(x.id || "").toLowerCase() == targetActionId);
                }

                if (!effect) {
                    // Fallback 2: Cocokkan berdasarkan Nama atau Deskripsi
                    effect = effects.find(
                        (x) =>
                            String(x.name || "").toLowerCase() == targetActionId ||
                            String(x.description || "").toLowerCase() == targetActionId
                    );
                }

                // Fallback 3: Safe Builder jika actionId dikirim langsung (agar aksi tetap terkirim ke server)
                if (!effect) {
                    effect = {
                        id: req.body.actionId,
                        name: req.body.actionName || req.body.actionId,
                        description: req.body.actionId,
                        category: req.body.categoryId || "Custom",
                    };
                    console.log("[API] Effect not in local list, using fallback payload:", effect);
                } else {
                    console.log("[API] Effect Found: ", effect);
                }

                let uniqueId = req.body.context?.userId || req.body.context?.uniqueId || req.body.uniqueId || "";
                let nickname = req.body.context?.username || req.body.context?.nickname || req.body.username || req.body.nickname || "";

                let findEffect = {
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
                    global.TiktokHandler.sendEffectToClients(findEffect);
                } else {
                    this.wsServer.clients.forEach((clients) => {
                        let edata = SendTheEffect(
                            findEffect,
                            global.userSeed,
                            global.rngInstance
                        );
                        clients.send(JSON.stringify(edata));
                    });
                }

                res.json({ data: [] });
            }
        );

        router.get("/", (req, res) => {
            res.send("Feature API is running!");
        });

        return router;
    }
}

export class API extends APIHandler {
    constructor(effectDataBase, wsServer) {
        super(effectDataBase, wsServer);
    }
}