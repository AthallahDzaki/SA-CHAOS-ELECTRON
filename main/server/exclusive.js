/**
 * exclusive.js - SA-CHAOS Mutual Exclusive Effect Management
 * 
 * Prevents game crashes and animation/logic bugs when conflicting effects
 * are triggered simultaneously, in rapid succession, or within combo chains.
 * 
 * Schema:
 * "exclusive": {
 *     "status": true / false,
 *     "effectToExclusive": [
 *         {
 *             "name": "EffectID",
 *             "delay": 12345
 *         }
 *     ]
 * }
 */

export class ExclusiveManager {
    constructor() {
        // Map<normalizedTargetId, { lockedUntil: number, lockedBy: string, effectName: string, delay: number, setAt: number }>
        this.locks = new Map();
    }

    /**
     * Normalizes an effect identifier (strips 'effect_' prefix, lowercase, removes spaces).
     * @param {string|number} val 
     * @returns {string}
     */
    normalizeId(val) {
        if (val === undefined || val === null) return "";
        return String(val)
            .trim()
            .toLowerCase()
            .replace(/^effect_/, "")
            .replace(/[\s_-]+/g, "_");
    }

    /**
     * Normalizes the exclusive field strictly to:
     * { status: boolean, effectToExclusive: Array<{ name: string, delay: number }> }
     * @param {any} exclusive 
     * @returns {{ status: boolean, effectToExclusive: Array<{ name: string, delay: number }> }}
     */
    normalizeExclusiveSchema(exclusive) {
        if (typeof exclusive === "boolean") {
            return {
                status: exclusive,
                effectToExclusive: [],
            };
        }

        if (exclusive && typeof exclusive === "object") {
            const status = Boolean(exclusive.status);
            const rawList = Array.isArray(exclusive.effectToExclusive)
                ? exclusive.effectToExclusive
                : [];

            const effectToExclusive = rawList
                .filter((item) => item && typeof item === "object" && item.name)
                .map((item) => {
                    let delayNum = 0;
                    if (typeof item.delay === "number" && !isNaN(item.delay)) {
                        delayNum = Math.max(0, Math.floor(item.delay));
                    } else if (typeof item.delay === "string") {
                        const parsed = parseInt(item.delay.replace(/[^\d]/g, ""), 10);
                        delayNum = isNaN(parsed) ? 0 : Math.max(0, parsed);
                    }
                    return {
                        name: String(item.name).trim(),
                        delay: delayNum,
                    };
                });

            return {
                status,
                effectToExclusive,
            };
        }

        return { status: false, effectToExclusive: [] };
    }

    /**
     * Resolves the exclusive configuration of an effect, checking the effect itself
     * or looking it up in the effectList if missing.
     * @param {object} effect 
     * @param {Array} effectList 
     * @returns {{ status: boolean, effectToExclusive: Array<{ name: string, delay: number }> }}
     */
    getEffectExclusiveConfig(effect, effectList = []) {
        if (!effect || typeof effect !== "object") {
            return { status: false, effectToExclusive: [] };
        }

        // If effect object directly carries exclusive property
        if (effect.exclusive !== undefined && effect.exclusive !== null) {
            return this.normalizeExclusiveSchema(effect.exclusive);
        }

        // Otherwise look up in master effect list
        if (Array.isArray(effectList) && effectList.length > 0) {
            const effId = this.normalizeId(effect.id);
            const effName = this.normalizeId(effect.name);
            const effDesc = this.normalizeId(effect.description);

            const found = effectList.find((item) => {
                if (!item) return false;
                const itemId = this.normalizeId(item.id);
                const itemName = this.normalizeId(item.name);
                const itemDesc = this.normalizeId(item.description);
                return (
                    (effId && itemId === effId) ||
                    (effName && itemName === effName) ||
                    (effDesc && itemDesc === effDesc)
                );
            });

            if (found && found.exclusive !== undefined) {
                return this.normalizeExclusiveSchema(found.exclusive);
            }
        }

        return { status: false, effectToExclusive: [] };
    }

    /**
     * Checks if an effect is currently under an active exclusive lock.
     * @param {object} effect 
     * @param {Array} effectList 
     * @returns {{ isLocked: boolean, remainingMs: number, lockedBy: string|null, delay: number, target: string|null }}
     */
    isLocked(effect, effectList = []) {
        this.cleanExpiredLocks();
        if (!effect) return { isLocked: false, remainingMs: 0, lockedBy: null, delay: 0, target: null };

        const now = Date.now();
        const effId = this.normalizeId(effect.id);
        const effName = this.normalizeId(effect.name);
        const effDesc = this.normalizeId(effect.description);

        const candidates = [effId, effName, effDesc].filter(Boolean);

        for (const key of candidates) {
            if (this.locks.has(key)) {
                const lock = this.locks.get(key);
                if (now < lock.lockedUntil) {
                    return {
                        isLocked: true,
                        remainingMs: lock.lockedUntil - now,
                        lockedBy: lock.lockedBy,
                        delay: lock.delay,
                        target: key,
                    };
                }
            }
        }

        return { isLocked: false, remainingMs: 0, lockedBy: null, delay: 0, target: null };
    }

    /**
     * Activates exclusive locks for all targets specified in the effect's effectToExclusive list.
     * @param {object} effect 
     * @param {Array} effectList 
     * @returns {Array<{ target: string, delay: number }>}
     */
    acquireLocks(effect, effectList = []) {
        if (!effect) return [];

        this.cleanExpiredLocks();
        const config = this.getEffectExclusiveConfig(effect, effectList);
        if (!config.status) return [];

        const now = Date.now();
        const sourceName = effect.name || effect.id || "Unknown Effect";
        const activatedLocks = [];

        for (const item of config.effectToExclusive) {
            if (!item.name) continue;
            const targetKey = this.normalizeId(item.name);
            const delay = Math.max(100, Number(item.delay) || 5000);

            this.locks.set(targetKey, {
                lockedUntil: now + delay,
                lockedBy: sourceName,
                delay,
                setAt: now,
            });

            activatedLocks.push({ target: targetKey, originalName: item.name, delay });
            console.log(
                `[EXCLUSIVE] 🔒 Effect [${sourceName}] activated exclusive lock for [${item.name}] (${delay}ms)`
            );
        }

        return activatedLocks;
    }

    /**
     * Calculates an intelligent, collision-free schedule for combo effects.
     * If Effect A excludes Effect B with a delay of 8000ms, Effect B will be postponed
     * to at least 8000ms after Effect A instead of firing 350ms later.
     * 
     * @param {Array} comboEffects - List of effect objects in the combo
     * @param {number} chainDelay - Default inter-effect delay in ms (e.g. 350ms)
     * @param {number} baseDelay - Initial starting delay in ms
     * @param {Array} effectList - Master effect list for config lookup
     * @returns {Array<{ effect: object, executionDelay: number }>}
     */
    calculateComboSchedule(comboEffects, chainDelay = 350, baseDelay = 0, effectList = []) {
        if (!Array.isArray(comboEffects) || comboEffects.length === 0) {
            return [];
        }

        const scheduled = [];
        let runningTimeline = baseDelay;

        comboEffects.forEach((effect, index) => {
            let requiredOffset = 0;
            let lockedByPrev = null;

            // 1. Check if any PREVIOUS effect in this combo chain has an exclusive rule against this effect
            for (const prev of scheduled) {
                const prevConfig = this.getEffectExclusiveConfig(prev.effect, effectList);
                if (prevConfig.status && Array.isArray(prevConfig.effectToExclusive)) {
                    const rule = prevConfig.effectToExclusive.find((r) => {
                        const targetId = this.normalizeId(r.name);
                        return (
                            targetId === this.normalizeId(effect.id) ||
                            targetId === this.normalizeId(effect.name) ||
                            targetId === this.normalizeId(effect.description)
                        );
                    });

                    if (rule) {
                        const ruleDelay = Math.max(100, Number(rule.delay) || 5000);
                        const minSafeTime = prev.executionDelay + ruleDelay;
                        if (minSafeTime > runningTimeline) {
                            runningTimeline = minSafeTime;
                            requiredOffset = ruleDelay;
                            lockedByPrev = prev.effect.name || prev.effect.id;
                        }
                    }
                }
            }

            // 2. Also check if this effect is currently locked by external active locks in memory
            const extLock = this.isLocked(effect, effectList);
            if (extLock.isLocked && extLock.remainingMs > 0) {
                const minSafeFromExt = baseDelay + extLock.remainingMs;
                if (minSafeFromExt > runningTimeline) {
                    runningTimeline = minSafeFromExt;
                    lockedByPrev = extLock.lockedBy;
                }
            }

            if (lockedByPrev) {
                console.log(
                    `[EXCLUSIVE COMBO] ⏱️ Efek [${effect.name || effect.id}] di-delay ke ${runningTimeline}ms karena exclusive lock dari [${lockedByPrev}]`
                );
            }

            scheduled.push({
                effect,
                executionDelay: runningTimeline,
            });

            // Advance timeline for the next effect in the chain
            runningTimeline += chainDelay;
        });

        return scheduled;
    }

    /**
     * Cleans up expired locks from memory.
     */
    cleanExpiredLocks() {
        const now = Date.now();
        for (const [key, lock] of this.locks.entries()) {
            if (now >= lock.lockedUntil) {
                this.locks.delete(key);
            }
        }
    }

    /**
     * Returns a snapshot of all active locks for monitoring/diagnostics.
     * @returns {Array<{ target: string, remainingMs: number, lockedBy: string, delay: number }>}
     */
    getActiveLocks() {
        this.cleanExpiredLocks();
        const now = Date.now();
        const active = [];

        for (const [key, lock] of this.locks.entries()) {
            active.push({
                target: key,
                remainingMs: Math.max(0, lock.lockedUntil - now),
                lockedBy: lock.lockedBy,
                delay: lock.delay,
            });
        }

        return active;
    }
}

export const exclusiveManager = new ExclusiveManager();
