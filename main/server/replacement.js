            // Interaction Mode Override for Spinwheel (FORTUNE ROULETTE / ROULETTE DEMOCRACY)
            const activeMode = GeneralConfig.Tiktok?.InteractionMode;
            
            let executeGift = true;
            if (activeMode === "vote") {
                console.log(`[TikTok Gift] Operating in ${activeMode} mode: Gift execution is bypassed, redirecting to Add Point Vote.`);
                executeGift = false;
            } else if (activeMode === "spinwheel" || activeMode === "hybrid_vote_spin") {
                let diamondCount = Number(
                    data.diamondCount ?? data.diamond_count ?? data.diamonds ?? data.diamondCost ?? 0
                );
                if (diamondCount <= 0 && gift) {
                    diamondCount = Number(gift.diamond_count ?? gift.cost ?? gift.diamonds ?? 0);
                }
                if (diamondCount <= 0) {
                    diamondCount = 1;
                }

                // Check minimal diamond setting
                let spinwheelData = readJson(path.join(APP_DATA_ROOT, "spinwheel-effects.json"), {});
                let minDiamonds = parseInt(spinwheelData?.settings?.minDiamonds ?? 1, 10);
                if (!Number.isFinite(minDiamonds) || minDiamonds < 1) {
                    minDiamonds = 1;
                }

                let totalDiamonds = (giftCountInfo.count || 1) * diamondCount;
                let effectiveDiamonds = Math.max(diamondCount, totalDiamonds);

                if (effectiveDiamonds < minDiamonds) {
                    console.log(`[TikTok Gift] Gift '${giftName}' (${effectiveDiamonds} diamond) di bawah batas minimal (${minDiamonds} diamond) untuk Spin Wheel. Lewati.`);
                    executeGift = false;
                } else {
                    console.log(`[TikTok Gift] Operating in ${activeMode} mode: routing gift '${giftName}' (${effectiveDiamonds} diamond >= ${minDiamonds} min) to Spin Wheel (${totalExecutions}x)`);
                    for (let r = 0; r < totalExecutions; r++) {
                        this.triggerSpinwheel({
                            username: uniqueId,
                            nickname: nickname || uniqueId,
                            giftName: giftName,
                            amount: diamondCount,
                            source: "gift",
                        });
                    }
                    executeGift = false;
                }
            }

            if (executeGift && gift != undefined) {
                let comboExecuted = this.executeGiftCombo(gift, uniqueId, senderInfo, totalExecutions);
                if (!comboExecuted && gift.run_effect != "") {
                    if (gift.run_effect === "none" || gift.run_effect === "no_effect") {
                        console.log(`[TikTok Gift] Gift '${gift.name}' received with no effect (overlay only). Skipping execution.`);
                    } else {
                        let giftDuration = Number(gift.duration);
                        let durationProp = Number.isFinite(giftDuration) && giftDuration > 0 ? { duration: giftDuration } : {};

                        if (gift.run_effect === "random") {
                            let effects = this.getEffectList();
                            if (effects && effects.length > 0) {
                                for (let r = 0; r < totalExecutions; r++) {
                                    let randomIndex = Math.floor(Math.random() * effects.length);
                                    this.enqueueGiftEffect({ ...effects[randomIndex], ...senderInfo, ...durationProp }, 1, true);
                                }
                            }
                        } else {
                            let special = this.parseSpecialEffect(gift.run_effect);
                            let handledSpecial = false;
                            if (special) {
                                if (special.isSpinwheel) {
                                    for (let r = 0; r < totalExecutions; r++) {
                                        this.triggerSpinwheel({
                                            username: uniqueId,
                                            nickname: nickname || uniqueId,
                                            giftName: gift.name,
                                            source: "gift",
                                        });
                                    }
                                    handledSpecial = true;
                                } else if (special.effect) {
                                    this.enqueueGiftEffect({ ...special.effect, ...senderInfo, ...durationProp }, totalExecutions, false);
                                    handledSpecial = true;
                                }
                            }
                            
                            if (!handledSpecial) {
                                let effects = this.getEffectList();
                                let findEffect = effects.find(
                                    (x) => x.description == gift.run_effect || x.name == gift.run_effect || x.id == gift.run_effect
                                );
                                if (findEffect == undefined && gift.run_effect) {
                                    // Safe Fallback Payload Builder
                                    findEffect = {
                                        id: gift.id || "gift_custom",
                                        name: gift.name || gift.run_effect,
                                        description: gift.run_effect,
                                        category: "Custom",
                                    };
                                    console.log(`[TikTok Gift] Using fallback payload for gift '${gift.name}':`, findEffect);
                                }
                                if (findEffect != undefined) {
                                    this.enqueueGiftEffect({ ...findEffect, ...senderInfo, ...durationProp }, totalExecutions, true);
                                }
                            }
                        }
                    }
                }
            }
