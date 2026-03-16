/* ============================================================
   TriggerMechanisms (ES5) — Teleport-Style UI + Ping + Locks + Messages
   ============================================================
   FEATURES
   - Plates trigger doors when ANY token is FULLY on the plate token bbox.
   - Supports:
     (A) Single Plate -> N Doors
     (B) Group (K-of-N plates) -> N Doors
   - Door modes:
     lock   => open/unlock when active; close/lock when inactive
     secret => reveal/open when active; hide/close/lock when inactive
   - UI (GM-only): Teleport-ish list cards with icon buttons
   - Ping plate
   - Trigger lock (mechanism lock):
       - locked + lockFreeze=false => forces doors to inactive state and ignores triggers
       - locked + lockFreeze=true  => freezes door state (no updates)
   - Config lock:
       - blocks edits; UI shows disabled buttons
       - GM Override grants 60s edit access
   - Auto-lock after first trigger:
       - when group first becomes active, apply active state, then lock+freeze
   - Trigger + Release messages (optional):
       - Plate: msgOn / msgOff (edge-triggered)
       - Group: msgOn / msgOff (edge-triggered)

   IMPORTANT
   - KEEP THE SAME STATE KEY FOREVER or bindings "disappear" (they won't be deleted; they'd be under the old key).
   ============================================================ */

var TriggerMechanisms = TriggerMechanisms || (function () {
    "use strict";

    var MOD = "TriggerMechanisms";

    // >>> KEEP THIS THE SAME FOREVER (use your existing key) <<<
    // If your current working script uses a different key, replace this string with THAT key once.
    var STATE = "TM_CAMPAIGN_CORE";

    var DEBOUNCE_MS = 120;
    var OVERRIDE_MS = 60000; // 60s config override
    var PRIMARY_EFFECT_TYPES = { none: true, alarm: true, damage: true, projectile: true, teleport: true, pit: true, reveal: true, save: true, status: true, spawn: true };
    var PRIMARY_EFFECT_TRIGGERS = { press: true, release: true, both: true };
    var SOURCE_KINDS = { pressurePlate: true, tripwire: true, proximity: true, manual: true, lever: true, button: true, doorState: true };
    var MOVE_LOCK_REENTRY = {};

    function defaultTriggerConfig(kind) {
        kind = String(kind || "pressurePlate");
        return {
            proximityRange: 1,
            doorStateMode: kind === "doorState" ? "open" : "open"
        };
    }

    function backfillTriggerConfig(kind, cfg) {
        cfg = cfg || {};
        if (typeof cfg.proximityRange === "undefined") cfg.proximityRange = 1;
        cfg.proximityRange = parseFloat(cfg.proximityRange, 10);
        if (isNaN(cfg.proximityRange) || cfg.proximityRange < 0) cfg.proximityRange = 1;
        if (typeof cfg.doorStateMode === "undefined") cfg.doorStateMode = "open";
        if (!/^(open|closed|locked|unlocked|revealed|hidden)$/.test(cfg.doorStateMode)) cfg.doorStateMode = "open";
        return cfg;
    }

    function defaultPrimaryEffectConfig() {
        return {
            enabled: false,
            type: "none",
            trigger: "press",
            message: "",
            damage: "1d6",
            projectile: {
                label: "Dart volley",
                damageType: "piercing"
            },
            save: {
                label: "DEX",
                dc: 12,
                successMsg: "",
                failMsg: "",
                successMode: "none",
                damageType: "",
                failDamage: ""
            },
            status: {
                markers: "cobweb",
                clearOnRelease: false,
                lastTargets: []
            },
            teleport: {
                pageId: "",
                left: 0,
                top: 0,
                name: ""
            },
            pit: {
                pageId: "",
                left: 0,
                top: 0,
                name: "",
                damage: "",
                damageType: "bludgeoning"
            },
            revealTargets: [],
            spawnTargets: [],
            effects: {
                lockToken: false,
                lockMarker: "fishing-net"
            }
        };
    }

    function backfillPrimaryEffectConfig(effect) {
        effect = effect || {};

        if (typeof effect.enabled === "undefined") effect.enabled = false;
        if (!PRIMARY_EFFECT_TYPES[effect.type]) effect.type = "none";
        if (!PRIMARY_EFFECT_TRIGGERS[effect.trigger]) effect.trigger = "press";
        if (typeof effect.message === "undefined") effect.message = "";
        if (typeof effect.damage === "undefined") effect.damage = "1d6";

        effect.projectile = effect.projectile || {};
        if (typeof effect.projectile.label === "undefined") effect.projectile.label = "Dart volley";
        if (typeof effect.projectile.damageType === "undefined") effect.projectile.damageType = "piercing";

        effect.save = effect.save || {};
        if (typeof effect.save.label === "undefined") effect.save.label = "DEX";
        if (typeof effect.save.dc === "undefined") effect.save.dc = 12;
        if (typeof effect.save.successMsg === "undefined") effect.save.successMsg = "";
        if (typeof effect.save.failMsg === "undefined") effect.save.failMsg = "";
        if (effect.save.successMode !== "half" && effect.save.successMode !== "none") effect.save.successMode = "none";
        if (typeof effect.save.damageType === "undefined") effect.save.damageType = "";
        if (typeof effect.save.failDamage === "undefined") effect.save.failDamage = "";

        effect.status = effect.status || {};
        if (typeof effect.status.markers === "undefined") effect.status.markers = "cobweb";
        if (typeof effect.status.clearOnRelease === "undefined") effect.status.clearOnRelease = false;
        if (!effect.status.lastTargets) effect.status.lastTargets = [];

        effect.teleport = effect.teleport || {};
        if (typeof effect.teleport.pageId === "undefined") effect.teleport.pageId = "";
        if (typeof effect.teleport.left === "undefined") effect.teleport.left = 0;
        if (typeof effect.teleport.top === "undefined") effect.teleport.top = 0;
        if (typeof effect.teleport.name === "undefined") effect.teleport.name = "";

        effect.pit = effect.pit || {};
        if (typeof effect.pit.pageId === "undefined") effect.pit.pageId = "";
        if (typeof effect.pit.left === "undefined") effect.pit.left = 0;
        if (typeof effect.pit.top === "undefined") effect.pit.top = 0;
        if (typeof effect.pit.name === "undefined") effect.pit.name = "";
        if (typeof effect.pit.damage === "undefined") effect.pit.damage = "";
        if (typeof effect.pit.damageType === "undefined") effect.pit.damageType = "bludgeoning";

        if (!effect.revealTargets) effect.revealTargets = [];
        if (!effect.spawnTargets) effect.spawnTargets = [];

        effect.effects = effect.effects || {};
        if (typeof effect.effects.lockToken === "undefined") effect.effects.lockToken = false;
        if (typeof effect.effects.lockMarker === "undefined") effect.effects.lockMarker = "fishing-net";
        if (typeof effect.effects.revealAlso === "undefined") effect.effects.revealAlso = false;

        return effect;
    }

    function getPrimaryEffect(mech) {
        if (!mech.effects) mech.effects = {};
        mech.effects.primary = backfillPrimaryEffectConfig(mech.effects.primary);
        return mech.effects.primary;
    }

    function newMechanismData(id) {
        return {
            id: id,
            kind: "single",
            legacyId: "",
            sourceKind: "pressurePlate",
            name: "",
            pageId: "",
            sources: [],
            triggerConfig: defaultTriggerConfig("pressurePlate"),
            rule: {
                mode: "single",
                k: 1,
                timing: "press"
            },
            effects: {
                doors: {},
                primary: defaultPrimaryEffectConfig()
            },
            messages: {
                on: "",
                off: ""
            },
            locks: {
                mechanismLocked: false,
                freezeWhenLocked: false,
                configLocked: false,
                autoLock: false,
                hasTriggered: false
            },
            runtime: {
                lastActive: false,
                lastOccupants: []
            }
        };
    }

    /* ---------- state ---------- */
    function ensureState() {
        state[STATE] = state[STATE] || {
            mechanisms: {},    // mechanismId -> normalized internal model for all mechanisms
            uiPageId: null,
            last: 0,
            editOverride: {},  // mechanismName -> expiry timestamp
            lockedTokens: {}   // tokenId -> { sourceId, left, top, pageId, marker }
        };

        var st = state[STATE];
        var mechId;

        if (!st.mechanisms) st.mechanisms = {};
        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            backfillMechanismData(st.mechanisms[mechId]);
        }
        if (!st.editOverride) st.editOverride = {};
        if (!st.lockedTokens) st.lockedTokens = {};

        return st;
    }

    function singleMechanismId(plateId) {
        return "single:" + plateId;
    }

    function multiMechanismId(mechanismName) {
        return "group:" + mechanismName;
    }

    function cloneDoorModes(doors) {
        var out = {};
        doors = doors || {};
        for (var did in doors) {
            if (!doors.hasOwnProperty(did)) continue;
            out[did] = doors[did];
        }
        return out;
    }

    function ensureMechanismData(mechId) {
        var st = ensureState();
        st.mechanisms[mechId] = st.mechanisms[mechId] || newMechanismData(mechId);
        backfillMechanismData(st.mechanisms[mechId]);
        return st.mechanisms[mechId];
    }

    function inferMechanismPageId(sourceIds) {
        for (var i = 0; i < sourceIds.length; i++) {
            var g = getObj("graphic", sourceIds[i]);
            if (g) return g.get("_pageid");
            var d = getObj("door", sourceIds[i]);
            if (d) return d.get("_pageid") || d.get("pageid") || "";
        }
        return "";
    }

    function backfillMechanismData(mech) {
        mech = mech || {};
        if (typeof mech.kind === "undefined") mech.kind = "single";
        if (typeof mech.legacyId === "undefined") mech.legacyId = "";
        if (typeof mech.sourceKind === "undefined") mech.sourceKind = "pressurePlate";
        if (!SOURCE_KINDS[mech.sourceKind]) mech.sourceKind = "pressurePlate";
        if (typeof mech.name === "undefined") mech.name = "";
        if (typeof mech.pageId === "undefined") mech.pageId = "";
        if (!mech.sources) mech.sources = [];
        mech.triggerConfig = backfillTriggerConfig(mech.sourceKind, mech.triggerConfig);
        mech.rule = mech.rule || {};
        if (typeof mech.rule.mode === "undefined") mech.rule.mode = mech.kind === "single" ? "single" : "kofn";
        if (typeof mech.rule.k === "undefined") mech.rule.k = mech.kind === "single" ? 1 : mech.sources.length;
        if (typeof mech.rule.timing === "undefined") mech.rule.timing = "press";
        if (typeof mech.rule.oneShot === "undefined") mech.rule.oneShot = false;
        if (typeof mech.rule.cooldownMs === "undefined") mech.rule.cooldownMs = 0;
        mech.rule.cooldownMs = parseInt(mech.rule.cooldownMs, 10);
        if (isNaN(mech.rule.cooldownMs) || mech.rule.cooldownMs < 0) mech.rule.cooldownMs = 0;
        if (typeof mech.rule.delayMs === "undefined") mech.rule.delayMs = 0;
        mech.rule.delayMs = parseInt(mech.rule.delayMs, 10);
        if (isNaN(mech.rule.delayMs) || mech.rule.delayMs < 0) mech.rule.delayMs = 0;
        mech.effects = mech.effects || {};
        if (!mech.effects.doors) mech.effects.doors = {};
        if (mech.effects.trap && !mech.effects.primary) mech.effects.primary = mech.effects.trap;
        delete mech.effects.trap;
        if (mech.kind === "single" || mech.effects.primary) mech.effects.primary = backfillPrimaryEffectConfig(mech.effects.primary);
        else mech.effects.primary = null;
        mech.messages = mech.messages || {};
        if (typeof mech.messages.on === "undefined") mech.messages.on = "";
        if (typeof mech.messages.off === "undefined") mech.messages.off = "";
        mech.locks = mech.locks || {};
        if (typeof mech.locks.mechanismLocked === "undefined") mech.locks.mechanismLocked = false;
        if (typeof mech.locks.freezeWhenLocked === "undefined") mech.locks.freezeWhenLocked = false;
        if (typeof mech.locks.configLocked === "undefined") mech.locks.configLocked = false;
        if (typeof mech.locks.autoLock === "undefined") mech.locks.autoLock = false;
        if (typeof mech.locks.hasTriggered === "undefined") mech.locks.hasTriggered = false;
        mech.runtime = mech.runtime || {};
        if (typeof mech.runtime.lastActive === "undefined") mech.runtime.lastActive = false;
        if (typeof mech.runtime.lastConditionActive === "undefined") mech.runtime.lastConditionActive = false;
        if (!mech.runtime.lastOccupants) mech.runtime.lastOccupants = [];
        if (typeof mech.runtime.manualActive === "undefined") mech.runtime.manualActive = false;
        if (typeof mech.runtime.cooldownUntil === "undefined") mech.runtime.cooldownUntil = 0;
        if (typeof mech.runtime.pendingToken === "undefined") mech.runtime.pendingToken = 0;
        if (typeof mech.runtime.pendingUntil === "undefined") mech.runtime.pendingUntil = 0;
        if (typeof mech.runtime.oneShotUsed === "undefined") mech.runtime.oneShotUsed = false;
        return mech;
    }

    function hasSingleMechanismRecord(sourceId) {
        return !!ensureState().mechanisms[singleMechanismId(sourceId)];
    }

    function getSingleMechanism(sourceId) {
        var mechId = singleMechanismId(sourceId);
        var mech = ensureMechanismData(mechId);
        var source = null;
        backfillMechanismData(mech);
        source = getSourceObject(sourceId, mech.sourceKind);
        if (!source) {
            source = getObj("graphic", sourceId);
            if (source) mech.sourceKind = "pressurePlate";
        }
        if (!source) {
            source = getObj("door", sourceId);
            if (source) mech.sourceKind = "doorState";
        }
        mech.kind = "single";
        mech.legacyId = sourceId;
        if (!SOURCE_KINDS[mech.sourceKind]) mech.sourceKind = "pressurePlate";
        mech.name = mech.name || sourceDisplayName(sourceId, mech.sourceKind, source);
        mech.pageId = sourcePageId(source, mech.sourceKind) || mech.pageId;
        mech.sources = [sourceId];
        mech.triggerConfig = backfillTriggerConfig(mech.sourceKind, mech.triggerConfig);
        mech.rule.mode = "single";
        mech.rule.k = 1;
        mech.effects.primary = getPrimaryEffect(mech);
        return mech;
    }

    function getMultiMechanism(mechanismName, createMissing) {
        var mechId = multiMechanismId(mechanismName);
        var st = ensureState();
        if (!createMissing && !st.mechanisms[mechId]) return null;
        var mech = ensureMechanismData(mechId);
        backfillMechanismData(mech);
        mech.kind = "group";
        mech.legacyId = mechanismName;
        mech.sourceKind = "pressurePlate";
        mech.name = mechanismName;
        mech.pageId = inferMechanismPageId(mech.sources || []);
        mech.triggerConfig = backfillTriggerConfig(mech.sourceKind, mech.triggerConfig);
        if (mech.rule.mode === "single") mech.rule.mode = "kofn";
        if (mech.rule.k < 0) mech.rule.k = 0;
        mech.effects.primary = null;
        return mech;
    }

    function pruneAllMechanisms() {
        var st = ensureState();
        var mechId;
        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            backfillMechanismData(st.mechanisms[mechId]);
            if (st.mechanisms[mechId].kind === "single") {
                var singleSourceId = st.mechanisms[mechId].legacyId;
                var graphic = getObj("graphic", singleSourceId);
                var door = getObj("door", singleSourceId);
                if (!graphic && !door) {
                    delete st.mechanisms[mechId];
                    continue;
                }
                if (!graphic && door) st.mechanisms[mechId].sourceKind = "doorState";
                st.mechanisms[mechId].pageId = inferMechanismPageId([singleSourceId]);
                continue;
            }
            pruneMechanismSourcesAndDoors({
                plates: st.mechanisms[mechId].sources,
                doors: st.mechanisms[mechId].effects.doors
            });
            st.mechanisms[mechId].pageId = inferMechanismPageId(st.mechanisms[mechId].sources);
        }
    }

    /* ---------- utils ---------- */
    function esc(s) {
        s = String(s || "");
        return s.replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function whisper(html) { sendChat("", "/w gm " + html); }
    function shortId(id) { return (id || "").slice(-6); }

    function safeGroupNameFromPage(pageName) {
        var s = String(pageName || "Map");
        s = s.replace(/[^A-Za-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
        if (!s) s = "Map";
        return s + "_Group";
    }

    function postTriggerMessage(raw) {
        raw = String(raw || "").trim();
        if (!raw) return;
        // Public narration. If you want GM-only, switch to: "/w gm "
        sendChat("", "/desc " + raw);
    }

    /* ---------- ping ---------- */
    function pingGraphic(g, playerid) {
        if (!g) return;
        sendPing(g.get("left"), g.get("top"), g.get("_pageid"), playerid, true);

        // aura flash GM-only
        var prev = {
            aura1_radius: g.get("aura1_radius"),
            aura1_color: g.get("aura1_color"),
            showplayers_aura1: g.get("showplayers_aura1")
        };

        g.set({ aura1_radius: 1, aura1_color: "#ff00ff", showplayers_aura1: false });

        setTimeout(function () {
            var gg = getObj("graphic", g.id);
            if (!gg) return;
            gg.set(prev);
        }, 1200);
    }

    function sourceObjectType(sourceKind) {
        return sourceKind === "doorState" ? "door" : "graphic";
    }

    function isControlledSourceKind(sourceKind) {
        return sourceKind === "manual" || sourceKind === "lever" || sourceKind === "button";
    }

    function getSourceObject(sourceId, sourceKind) {
        return getObj(sourceObjectType(sourceKind), sourceId);
    }

    function sourcePageId(sourceObj, sourceKind) {
        if (!sourceObj) return "";
        if (sourceKind === "doorState") return sourceObj.get("_pageid") || sourceObj.get("pageid") || "";
        return sourceObj.get("_pageid") || "";
    }

    function sourcePosition(sourceObj, sourceKind) {
        var left;
        var top;
        if (!sourceObj) return null;
        if (sourceKind === "doorState") {
            left = sourceObj.get("x");
            top = sourceObj.get("y");
            if (typeof left !== "number") left = sourceObj.get("left");
            if (typeof top !== "number") top = sourceObj.get("top");
        } else {
            left = sourceObj.get("left");
            top = sourceObj.get("top");
        }
        if (typeof left !== "number" || typeof top !== "number") return null;
        return { left: left, top: top, pageId: sourcePageId(sourceObj, sourceKind) };
    }

    function sourceDisplayName(sourceId, sourceKind, sourceObj) {
        if (sourceKind === "doorState") return "Door …" + shortId(sourceId);
        return (sourceObj && sourceObj.get("name")) || ("Trigger …" + shortId(sourceId));
    }

    function cmdPingSource(playerid, sourceId) {
        var graphic = getObj("graphic", sourceId);
        var door = getObj("door", sourceId);
        var pos;
        if (graphic) return pingGraphic(graphic, playerid);
        if (!door) return whisper("Trigger not found.");
        pos = sourcePosition(door, "doorState");
        if (!pos) return whisper("This door trigger cannot be pinged.");
        sendPing(pos.left, pos.top, pos.pageId, playerid, true);
    }

    /* ---------- geometry ---------- */
    function rect(g) {
        var x = g.get("left"), y = g.get("top"), w = g.get("width"), h = g.get("height");
        return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
    }

    function rectsIntersect(a, b) {
        return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    // token bbox must be FULLY inside plate bbox
    function fullyInside(pr, tr) {
        return (tr.left >= pr.left && tr.right <= pr.right && tr.top >= pr.top && tr.bottom <= pr.bottom);
    }

    function distanceBetweenGraphics(a, b) {
        var dx = a.get("left") - b.get("left");
        var dy = a.get("top") - b.get("top");
        return Math.sqrt((dx * dx) + (dy * dy));
    }

    function pageCellSize(pageId) {
        var page = getObj("page", pageId);
        var snapping = page ? parseFloat(page.get("snapping_increment"), 10) : 1;
        if (isNaN(snapping) || snapping <= 0) snapping = 1;
        return 70 * snapping;
    }

    function tokensOnObjectsLayer(pageId) {
        return findObjs({ _type: "graphic", _subtype: "token", layer: "objects", _pageid: pageId }) || [];
    }

    function isSourceOccupied(sourceGraphic) {
        return sourceOccupants(sourceGraphic).length > 0;
    }

    function sourceOccupants(sourceGraphic) {
        var pr = rect(sourceGraphic);
        var toks = tokensOnObjectsLayer(sourceGraphic.get("_pageid"));
        var hits = [];
        for (var i = 0; i < toks.length; i++) {
            if (fullyInside(pr, rect(toks[i]))) hits.push(toks[i]);
        }
        return hits;
    }

    function sourceIntersections(sourceGraphic) {
        var sr = rect(sourceGraphic);
        var toks = tokensOnObjectsLayer(sourceGraphic.get("_pageid"));
        var hits = [];
        for (var i = 0; i < toks.length; i++) {
            if (rectsIntersect(sr, rect(toks[i]))) hits.push(toks[i]);
        }
        return hits;
    }

    function sourceNearbyTokens(sourceGraphic, triggerConfig) {
        var toks = tokensOnObjectsLayer(sourceGraphic.get("_pageid"));
        var hits = [];
        var radius = backfillTriggerConfig("proximity", triggerConfig).proximityRange * pageCellSize(sourceGraphic.get("_pageid"));
        for (var i = 0; i < toks.length; i++) {
            if (distanceBetweenGraphics(sourceGraphic, toks[i]) <= radius) hits.push(toks[i]);
        }
        return hits;
    }

    function sourceKindLabel(kind) {
        if (kind === "tripwire") return "Tripwire";
        if (kind === "proximity") return "Proximity";
        if (kind === "manual") return "Manual";
        if (kind === "lever") return "Lever";
        if (kind === "button") return "Button";
        if (kind === "doorState") return "Door State";
        return "Pressure Plate";
    }

    function sourceStateLabel(kind, active) {
        if (kind === "manual") return active ? "ACTIVE" : "INACTIVE";
        if (kind === "lever") return active ? "ON" : "OFF";
        if (kind === "button") return active ? "PRESSED" : "RELEASED";
        if (kind === "tripwire") return active ? "CROSSED" : "CLEAR";
        if (kind === "proximity") return active ? "IN RANGE" : "CLEAR";
        if (kind === "doorState") return active ? "MATCHED" : "UNMATCHED";
        return active ? "OCCUPIED" : "CLEAR";
    }

    function doorStateModeLabel(mode) {
        if (mode === "closed") return "Closed";
        if (mode === "locked") return "Locked";
        if (mode === "unlocked") return "Unlocked";
        if (mode === "revealed") return "Revealed";
        if (mode === "hidden") return "Hidden";
        return "Open";
    }

    function doorStateMatches(door, mode) {
        if (!door) return false;
        if (mode === "closed") return !door.get("isOpen");
        if (mode === "locked") return !!door.get("isLocked");
        if (mode === "unlocked") return !door.get("isLocked");
        if (mode === "revealed") return !door.get("isSecret");
        if (mode === "hidden") return !!door.get("isSecret");
        return !!door.get("isOpen");
    }

    function singleMechanismState(mech) {
        var source = getSourceObject(mech.sources[0], mech.sourceKind);
        var targets = [];
        var active = false;

        if (isControlledSourceKind(mech.sourceKind)) {
            active = !!mech.runtime.manualActive;
            return { active: active, targets: [], source: source };
        }
        if (!source) return { active: false, targets: [], source: null };

        if (mech.sourceKind === "doorState") {
            active = doorStateMatches(source, mech.triggerConfig.doorStateMode);
            return { active: active, targets: [], source: source };
        }
        if (mech.sourceKind === "tripwire") targets = sourceIntersections(source);
        else if (mech.sourceKind === "proximity") targets = sourceNearbyTokens(source, mech.triggerConfig);
        else targets = sourceOccupants(source);

        active = targets.length > 0;
        return { active: active, targets: targets, source: source };
    }

    function sourceMechanismStateById(sourceId) {
        return singleMechanismState(getSingleMechanism(sourceId));
    }

    /* ---------- door ops ---------- */
    function applyOccupied(door, mode) {
        if (!door) return;
        if (mode === "lock") {
            door.set({ isLocked: false, isOpen: true });
        }
        if (mode === "secret") {
            door.set({ isSecret: false, isLocked: false, isOpen: true });
        }
    }

    function applyUnoccupied(door, mode) {
        if (!door) return;
        if (mode === "lock") {
            door.set({ isOpen: false, isLocked: true });
        }
        if (mode === "secret") {
            door.set({ isOpen: false, isSecret: true, isLocked: true });
        }
    }

    function primaryEffectFiresOnEdge(trigger, wasActive, isActive) {
        if (trigger === "press") return isActive && !wasActive;
        if (trigger === "release") return !isActive && wasActive;
        if (trigger === "both") return isActive !== wasActive;
        return false;
    }

    function primaryEffectTypeLabel(type) {
        if (type === "alarm") return "Alarm";
        if (type === "damage") return "Damage";
        if (type === "projectile") return "Projectile";
        if (type === "teleport") return "Teleport";
        if (type === "pit") return "Pit / Force Move";
        if (type === "reveal") return "Reveal";
        if (type === "save") return "Save";
        if (type === "status") return "Status";
        if (type === "spawn") return "Spawn";
        return "None";
    }

    function primaryEffectTriggerLabel(trigger) {
        if (trigger === "press") return "Press";
        if (trigger === "release") return "Release";
        if (trigger === "both") return "Both";
        return "Press";
    }

    function durationSecondsLabel(ms) {
        var seconds = (parseInt(ms, 10) || 0) / 1000;
        var text = String(seconds);
        if (Math.floor(seconds) === seconds) text = String(Math.floor(seconds));
        return text + "s";
    }

    function cooldownRemainingMs(mech, now) {
        now = now || Date.now();
        return Math.max(0, (parseInt(mech.runtime.cooldownUntil, 10) || 0) - now);
    }

    function mechanismRuleExtras(mech) {
        var out = [];
        if (mech.rule.delayMs > 0) out.push("Delay " + durationSecondsLabel(mech.rule.delayMs));
        if (mech.rule.cooldownMs > 0) out.push("Cooldown " + durationSecondsLabel(mech.rule.cooldownMs));
        if (mech.rule.oneShot) out.push("One-Shot");
        return out;
    }

    function joinTokenNames(tokens) {
        var names = [];
        for (var i = 0; i < tokens.length; i++) {
            names.push(tokens[i].get("name") || ("Token …" + shortId(tokens[i].id)));
        }
        return names.join(", ");
    }

    function getGraphicsByIds(ids) {
        var out = [];
        ids = ids || [];
        for (var i = 0; i < ids.length; i++) {
            var g = getObj("graphic", ids[i]);
            if (g) out.push(g);
        }
        return out;
    }

    function parseMarkerList(raw) {
        var seen = {};
        var out = [];
        raw = String(raw || "");
        var parts = raw.split(",");

        for (var i = 0; i < parts.length; i++) {
            var marker = String(parts[i] || "").replace(/^\s+|\s+$/g, "");
            if (!marker || seen[marker]) continue;
            seen[marker] = true;
            out.push(marker);
        }

        return out;
    }

    function applyMarkersToToken(token, markers) {
        if (!token || !markers.length) return;

        var current = parseMarkerList(token.get("statusmarkers"));
        var map = {};
        var out = [];
        var i;

        for (i = 0; i < current.length; i++) {
            map[current[i]] = true;
            out.push(current[i]);
        }
        for (i = 0; i < markers.length; i++) {
            if (map[markers[i]]) continue;
            out.push(markers[i]);
        }

        token.set({ statusmarkers: out.join(",") });
    }

    function removeMarkersFromToken(token, markers) {
        if (!token || !markers.length) return;

        var current = parseMarkerList(token.get("statusmarkers"));
        var removeMap = {};
        var out = [];
        var i;

        for (i = 0; i < markers.length; i++) removeMap[markers[i]] = true;
        for (i = 0; i < current.length; i++) if (!removeMap[current[i]]) out.push(current[i]);

        token.set({ statusmarkers: out.join(",") });
    }

    function lockTokenToCurrentPosition(token, sourceId, marker) {
        if (!token) return;

        var st = ensureState();
        st.lockedTokens[token.id] = {
            sourceId: sourceId,
            left: token.get("left"),
            top: token.get("top"),
            pageId: token.get("_pageid"),
            marker: marker || ""
        };

        if (marker) applyMarkersToToken(token, [marker]);
    }

    function maybeApplyLockEffect(sourceId, effect, tokens) {
        if (!effect.effects || !effect.effects.lockToken) return;
        for (var i = 0; i < tokens.length; i++) lockTokenToCurrentPosition(tokens[i], sourceId, effect.effects.lockMarker);
    }

    function unlockTokenById(tokenId) {
        var st = ensureState();
        var lock = st.lockedTokens[tokenId];
        if (!lock) return false;

        var token = getObj("graphic", tokenId);
        if (token && lock.marker) removeMarkersFromToken(token, [lock.marker]);
        delete st.lockedTokens[tokenId];
        return true;
    }

    function unlockTokensForSource(sourceId) {
        var st = ensureState();
        var count = 0;

        for (var tokenId in st.lockedTokens) {
            if (!st.lockedTokens.hasOwnProperty(tokenId)) continue;
            if (st.lockedTokens[tokenId].sourceId !== sourceId) continue;
            if (unlockTokenById(tokenId)) count++;
        }

        return count;
    }

    function lockedCountForSource(sourceId) {
        var st = ensureState();
        var count = 0;
        for (var tokenId in st.lockedTokens) {
            if (!st.lockedTokens.hasOwnProperty(tokenId)) continue;
            if (st.lockedTokens[tokenId].sourceId === sourceId) count++;
        }
        return count;
    }

    function runRevealTargets(refs) {
        var changed = 0;
        for (var i = 0; i < refs.length; i++) {
            var ref = String(refs[i] || "");
            var parts = ref.split(":");
            if (parts.length !== 2) continue;

            var type = parts[0];
            var id = parts[1];
            var obj = getObj(type, id);
            if (!obj) continue;

            if (type === "graphic") {
                if (obj.get("layer") === "gmlayer") {
                    obj.set({ layer: "objects" });
                    changed++;
                }
            } else if (type === "door") {
                if (obj.get("isSecret")) {
                    obj.set({ isSecret: false });
                    changed++;
                }
            }
        }
        return changed;
    }

    function maybeApplyRevealEffect(effect) {
        if (!effect || !effect.revealTargets || !effect.revealTargets.length) return 0;
        return runRevealTargets(effect.revealTargets);
    }

    function runTeleport(tokens, dest) {
        if (!dest || !dest.pageId) return 0;

        var moved = 0;
        for (var i = 0; i < tokens.length; i++) {
            tokens[i].set({
                _pageid: dest.pageId,
                left: dest.left,
                top: dest.top,
                layer: "objects"
            });
            moved++;
        }
        return moved;
    }

    function runSpawnTargets(refs) {
        var changed = 0;
        for (var i = 0; i < refs.length; i++) {
            var g = getObj("graphic", refs[i]);
            if (!g) continue;
            if (g.get("layer") === "gmlayer") {
                g.set({ layer: "objects" });
                changed++;
            }
        }
        return changed;
    }

    function formatSaveEffectMessage(targetNames, effect, customMsg) {
        var parts = [];
        var save = effect.save || {};
        var label = String(save.label || "DEX").toUpperCase();
        var dc = parseInt(save.dc, 10);
        var damageType = String(save.damageType || "").replace(/^\s+|\s+$/g, "");
        if (isNaN(dc) || dc < 1) dc = 12;

        if (customMsg) parts.push(customMsg);
        parts.push(targetNames + " must make a " + label + " save (DC " + dc + ").");
        if (String(save.successMsg || "").trim()) parts.push("Success: " + String(save.successMsg).trim() + ".");
        if (save.successMode === "half") {
            parts.push("Success: half of fail damage" + (damageType ? " (" + damageType + ")" : "") + ".");
        } else {
            parts.push("Success: no damage.");
        }
        if (String(save.failMsg || "").trim()) parts.push("Fail: " + String(save.failMsg).trim() + ".");
        if (String(save.failDamage || "").trim()) parts.push("Fail damage: [[" + String(save.failDamage).trim() + "]]" + (damageType ? " " + damageType : "") + ".");

        return parts.join(" ");
    }

    function damageTypeSuffix(type) {
        type = String(type || "").replace(/^\s+|\s+$/g, "");
        return type ? " " + type : "";
    }

    function executePrimaryEffect(source, effect, targets) {
        if (!source || !effect) return;

        effect = backfillPrimaryEffectConfig(effect);
        if (!effect.enabled || effect.type === "none") return;

        var sourceName = source.get("name") || ("Trigger …" + shortId(source.id));
        var targetNames = targets.length ? joinTokenNames(targets) : sourceName;
        var customMsg = String(effect.message || "").trim();
        var revealCount = 0;

        if (effect.type !== "reveal" && effect.effects && effect.effects.revealAlso) {
            revealCount = maybeApplyRevealEffect(effect);
        }

        if (effect.type === "alarm") {
            postTriggerMessage(customMsg || ("Effect triggered at " + sourceName + "."));
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }

        if (effect.type === "damage") {
            postTriggerMessage((customMsg || "Effect hits") + ": " + targetNames + " take [[" + String(effect.damage || "1d6") + "]] damage.");
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }

        if (effect.type === "projectile") {
            var projectileLabel = String(effect.projectile.label || "Projectile").replace(/^\s+|\s+$/g, "") || "Projectile";
            postTriggerMessage((customMsg || projectileLabel + " fires") + ": " + targetNames + " take [[" + String(effect.damage || "1d6") + "]]" + damageTypeSuffix(effect.projectile.damageType) + " damage.");
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }

        if (effect.type === "teleport") {
            if (!effect.teleport.pageId) return;
            if (!targets.length) return;

            var moved = runTeleport(targets, effect.teleport);
            maybeApplyLockEffect(source.id, effect, targets);
            if (moved && customMsg) postTriggerMessage(customMsg);
            return;
        }

        if (effect.type === "pit") {
            var pitMoved = 0;
            var pitMsg = customMsg || "The ground gives way";
            if (targets.length && effect.pit.pageId) pitMoved = runTeleport(targets, effect.pit);
            if (pitMoved || String(effect.pit.damage || "").trim()) {
                var msg = pitMsg + ": " + targetNames;
                if (pitMoved && effect.pit.pageId) msg += " are forced to " + (effect.pit.name || "the pit destination");
                if (String(effect.pit.damage || "").trim()) msg += " and take [[" + String(effect.pit.damage).trim() + "]]" + damageTypeSuffix(effect.pit.damageType) + " damage";
                postTriggerMessage(msg + ".");
            }
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }

        if (effect.type === "reveal") {
            var revealed = maybeApplyRevealEffect(effect);
            maybeApplyLockEffect(source.id, effect, targets);
            if (revealed && customMsg) postTriggerMessage(customMsg);
            return;
        }

        if (effect.type === "save") {
            postTriggerMessage(formatSaveEffectMessage(targetNames, effect, customMsg));
            if (revealCount && !customMsg) postTriggerMessage("Hidden elements are revealed.");
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }

        if (effect.type === "status") {
            var markers = parseMarkerList(effect.status.markers);
            for (var i = 0; i < targets.length; i++) applyMarkersToToken(targets[i], markers);
            effect.status.lastTargets = [];
            for (i = 0; i < targets.length; i++) effect.status.lastTargets.push(targets[i].id);
            if (customMsg) postTriggerMessage(customMsg);
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }

        if (effect.type === "spawn") {
            var spawned = runSpawnTargets(effect.spawnTargets || []);
            if (spawned) postTriggerMessage(customMsg || ("Spawn effect triggered at " + sourceName + "."));
            if (revealCount && !customMsg) postTriggerMessage("Hidden elements are revealed.");
            maybeApplyLockEffect(source.id, effect, targets);
            return;
        }
    }

    /* ---------- evaluation: single plate ---------- */
    function countActiveMechanismSources(mech) {
        var count = 0;
        for (var i = 0; i < mech.sources.length; i++) {
            if (sourceMechanismStateById(mech.sources[i]).active) count++;
        }
        return count;
    }

    function applyDoorEffects(doors, active) {
        for (var doorId in doors) {
            if (!doors.hasOwnProperty(doorId)) continue;
            if (active) applyOccupied(getObj("door", doorId), doors[doorId]);
            else applyUnoccupied(getObj("door", doorId), doors[doorId]);
        }
    }

    function clearPendingActivation(mech) {
        mech.runtime.pendingToken = (parseInt(mech.runtime.pendingToken, 10) || 0) + 1;
        mech.runtime.pendingUntil = 0;
    }

    function mechanismCanActivate(mech, now) {
        now = now || Date.now();
        if (mech.rule.oneShot && mech.runtime.oneShotUsed) return false;
        return cooldownRemainingMs(mech, now) <= 0;
    }

    function consumeMechanismActivation(mech, now) {
        now = now || Date.now();
        if (mech.rule.cooldownMs > 0) mech.runtime.cooldownUntil = now + mech.rule.cooldownMs;
        else mech.runtime.cooldownUntil = 0;
        if (mech.rule.oneShot) mech.runtime.oneShotUsed = true;
    }

    function singleSourceFallback(mech) {
        return { id: mech.legacyId, get: function () { return mech.name || ("Trigger …" + shortId(mech.legacyId)); } };
    }

    function clearSingleStatusOnRelease(mech, primary) {
        if (!(primary && primary.type === "status" && primary.status.clearOnRelease && mech.rule.timing === "press")) return;
        var clearMarkers = parseMarkerList(primary.status.markers);
        var clearTargets = getGraphicsByIds(primary.status.lastTargets);
        for (var i = 0; i < clearTargets.length; i++) removeMarkersFromToken(clearTargets[i], clearMarkers);
        primary.status.lastTargets = [];
    }

    function activateSingleMechanism(mech, sourceState, now) {
        var primary = getPrimaryEffect(mech);
        var source = sourceState.source || singleSourceFallback(mech);
        var occupants = sourceState.targets || [];
        postTriggerMessage(mech.messages.on);
        applyDoorEffects(mech.effects.doors, true);
        if (primary && primaryEffectFiresOnEdge(mech.rule.timing, false, true)) {
            executePrimaryEffect(source, primary, occupants);
        }
        mech.runtime.lastActive = true;
        mech.runtime.lastOccupants = [];
        for (var i = 0; i < occupants.length; i++) mech.runtime.lastOccupants.push(occupants[i].id);
        consumeMechanismActivation(mech, now);
    }

    function releaseSingleMechanism(mech, sourceState) {
        var primary = getPrimaryEffect(mech);
        var source = (sourceState && sourceState.source) || singleSourceFallback(mech);
        var prevOccupants = getGraphicsByIds(mech.runtime.lastOccupants);
        postTriggerMessage(mech.messages.off);
        applyDoorEffects(mech.effects.doors, false);
        clearSingleStatusOnRelease(mech, primary);
        if (primary && primaryEffectFiresOnEdge(mech.rule.timing, true, false)) {
            executePrimaryEffect(source, primary, prevOccupants);
        }
        mech.runtime.lastActive = false;
        mech.runtime.lastOccupants = [];
    }

    function activateMultiMechanism(mech, now) {
        postTriggerMessage(mech.messages.on);
        mech.runtime.lastActive = true;
        if (!mech.locks.hasTriggered) mech.locks.hasTriggered = true;
        applyDoorEffects(mech.effects.doors, true);
        consumeMechanismActivation(mech, now);
        if (mech.locks.autoLock) {
            mech.locks.mechanismLocked = true;
            mech.locks.freezeWhenLocked = true;
            mech.runtime.lastActive = false;
        }
    }

    function releaseMultiMechanism(mech) {
        postTriggerMessage(mech.messages.off);
        mech.runtime.lastActive = false;
        applyDoorEffects(mech.effects.doors, false);
    }

    function scheduleMechanismActivation(mech) {
        var delayMs = parseInt(mech.rule.delayMs, 10) || 0;
        var token;
        if (delayMs <= 0) return false;
        token = (parseInt(mech.runtime.pendingToken, 10) || 0) + 1;
        mech.runtime.pendingToken = token;
        mech.runtime.pendingUntil = Date.now() + delayMs;

        setTimeout(function () {
            var delayed = ensureState().mechanisms[mech.id];
            var sourceState;
            var rawActive;
            var pressed;
            var required;
            var now = Date.now();
            if (!delayed) return;
            backfillMechanismData(delayed);
            if (delayed.runtime.pendingToken !== token) return;
            delayed.runtime.pendingUntil = 0;
            if (!mechanismCanActivate(delayed, now) || delayed.runtime.lastActive) return;

            if (delayed.kind === "single") {
                sourceState = singleMechanismState(delayed);
                rawActive = sourceState.active;
                if (!rawActive) return;
                activateSingleMechanism(delayed, sourceState, now);
                commitMechanism(delayed);
                return;
            }

            if (delayed.locks.mechanismLocked) return;
            pruneMechanismSourcesAndDoors({ plates: delayed.sources, doors: delayed.effects.doors });
            delayed.pageId = inferMechanismPageId(delayed.sources);
            pressed = countActiveMechanismSources(delayed);
            required = mechanismRequiredCount(delayed);
            if (required < 1) required = delayed.sources.length;
            rawActive = delayed.sources.length > 0 && pressed >= required;
            if (!rawActive) return;
            activateMultiMechanism(delayed, now);
            commitMechanism(delayed);
        }, delayMs);

        return true;
    }

    function evaluateMechanism(mech) {
        if (!mech) return;
        backfillMechanismData(mech);

        if (mech.kind === "single") {
            var primary = getPrimaryEffect(mech);
            var sourceState = singleMechanismState(mech);
            var source = sourceState.source;
            var rawActive = sourceState.active;
            var wasRawActive = !!mech.runtime.lastConditionActive;
            var wasActive = !!mech.runtime.lastActive;
            var now = Date.now();
            if (!source && !isControlledSourceKind(mech.sourceKind)) return;
            var occupants = sourceState.targets;
            if (!rawActive) {
                clearPendingActivation(mech);
                if (wasActive) releaseSingleMechanism(mech, sourceState);
                mech.runtime.lastConditionActive = false;
                return;
            }

            if (wasActive) {
                applyDoorEffects(mech.effects.doors, true);
                mech.runtime.lastConditionActive = true;
                mech.runtime.lastOccupants = [];
                for (i = 0; i < occupants.length; i++) mech.runtime.lastOccupants.push(occupants[i].id);
                return;
            }

            if (!wasRawActive && mechanismCanActivate(mech, now)) {
                if (!scheduleMechanismActivation(mech)) {
                    activateSingleMechanism(mech, sourceState, now);
                }
            }

            mech.runtime.lastConditionActive = true;
            return;
        }

        pruneMechanismSourcesAndDoors({
            plates: mech.sources,
            doors: mech.effects.doors
        });

        mech.pageId = inferMechanismPageId(mech.sources);

        if (mech.locks.mechanismLocked) {
            clearPendingActivation(mech);
            mech.runtime.lastConditionActive = false;
            mech.runtime.lastActive = false;
            if (!mech.locks.freezeWhenLocked) applyDoorEffects(mech.effects.doors, false);
            return;
        }

        var pressed = countActiveMechanismSources(mech);
        var required = mech.rule.mode === "all" ? mech.sources.length : mech.rule.k;
        if (required < 1) required = mech.sources.length;
        var active = mech.sources.length > 0 && pressed >= required;
        var wasGroupRawActive = !!mech.runtime.lastConditionActive;
        var wasGroupActive = !!mech.runtime.lastActive;
        var groupNow = Date.now();

        if (!active) {
            clearPendingActivation(mech);
            if (wasGroupActive) releaseMultiMechanism(mech);
            mech.runtime.lastConditionActive = false;
            return;
        }

        if (wasGroupActive) {
            applyDoorEffects(mech.effects.doors, true);
            mech.runtime.lastConditionActive = true;
            return;
        }

        if (!wasGroupRawActive && mechanismCanActivate(mech, groupNow)) {
            if (!scheduleMechanismActivation(mech)) {
                activateMultiMechanism(mech, groupNow);
            }
        }

        mech.runtime.lastConditionActive = true;
    }

    function evaluateSingleMechanism(plateId) {
        evaluateMechanism(getSingleMechanism(plateId));
    }

    /* ---------- evaluation: groups ---------- */
    function pruneMechanismSourcesAndDoors(g) {
        // plates
        var cleanedPlates = [];
        for (var i = 0; i < g.plates.length; i++) {
            if (getObj("graphic", g.plates[i]) || getObj("door", g.plates[i])) cleanedPlates.push(g.plates[i]);
        }
        g.plates = cleanedPlates;

        // doors
        var cleanedDoors = {};
        for (var did in g.doors) {
            if (!g.doors.hasOwnProperty(did)) continue;
            if (getObj("door", did)) cleanedDoors[did] = g.doors[did];
        }
        g.doors = cleanedDoors;
    }

    function countPressedGroupSources(group) {
        var count = 0;
        for (var i = 0; i < group.plates.length; i++) {
            var pid = group.plates[i];
            var plate = getObj("graphic", pid);
            if (!plate) continue;
            if (isSourceOccupied(plate)) count++;
        }
        return count;
    }

    function clampRequiredSources(g) {
        var n = g.plates.length;
        var req = parseInt(g.required, 10);
        if (isNaN(req) || req < 0) req = 0; // 0 => ALL
        if (req === 0) return n;
        if (req > n) return n;
        return req;
    }

    function evaluateMultiSourceMechanism(mechanismName) {
        evaluateMechanism(getMultiMechanism(mechanismName, false));
    }

    function evaluateAll() {
        var st = ensureState();
        pruneAllMechanisms();

        for (var mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            evaluateMechanism(st.mechanisms[mechId]);
        }
    }

    function debouncedCheck() {
        var st = ensureState();
        var now = Date.now();
        if (now - st.last < DEBOUNCE_MS) return;
        st.last = now;
        evaluateAll();
    }

    /* ---------- page handling ---------- */
    function getGMViewPageId(playerid) {
        var p = getObj("player", playerid);
        var last = p && p.get("lastpage");
        return last || Campaign().get("playerpageid");
    }

    function setUIPage(playerid) { ensureState().uiPageId = getGMViewPageId(playerid); }
    function getUIPage(playerid) {
        var st = ensureState();
        if (!st.uiPageId) st.uiPageId = getGMViewPageId(playerid);
        return st.uiPageId;
    }

    function getUIPageName(pageId) {
        var p = getObj("page", pageId);
        return (p && p.get("name")) ? p.get("name") : "Map";
    }

    /* ---------- config lock enforcement ---------- */
    function hasMechanismEditOverride(mechanismName) {
        var st = ensureState();
        var exp = st.editOverride[mechanismName];
        if (!exp) return false;
        if (Date.now() > exp) {
            delete st.editOverride[mechanismName];
            return false;
        }
        return true;
    }

    function requireMechanismConfigEditable(mechanismName) {
        var mech = getMultiMechanism(mechanismName, false);
        if (!mech) return true;
        if (!mech.locks.configLocked) return true;
        if (hasMechanismEditOverride(mechanismName)) return true;
        whisper("Group <b>" + esc(mechanismName) + "</b> is <b>CONFIG LOCKED</b>. Use <b>Override</b> to edit for 60s.");
        return false;
    }

    /* ---------- UI buttons ---------- */
    function iconBtn(icon, cmd, title) {
        return '<a title="' + esc(title || "") + '" style="' +
            'display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;' +
            'background:#f3f4f6;border:2px solid #111;border-radius:10px;' +
            'text-decoration:none;color:#111;font-size:18px;font-weight:900;' +
            'margin:0 10px 6px 0;" href="' + esc(cmd) + '">' + esc(icon) + '</a>';
    }

    function iconBtnDisabled(icon, title) {
        return '<span title="' + esc(title || "") + '" style="' +
            'display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;' +
            'background:#e5e7eb;border:2px solid #9ca3af;border-radius:10px;' +
            'color:#6b7280;font-size:18px;font-weight:900;' +
            'margin:0 10px 6px 0;opacity:.7;">' + esc(icon) + '</span>';
    }

    function badge(text, ok) {
        return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;' +
            'background:' + (ok ? "#16a34a" : "#ef4444") + ';color:#fff;font-size:11px;font-weight:900;' +
            'margin-left:8px;border:1px solid rgba(0,0,0,.35);">' + esc(text) + "</span>";
    }

    function mini(label, cmd, title) {
        return '<a title="' + esc(title || "") + '" style="' +
            'display:inline-block;padding:2px 10px;border-radius:999px;background:#fff;border:2px solid #111;' +
            'text-decoration:none;color:#111;font-size:11px;font-weight:900;margin:0 8px 6px 0;" href="' + esc(cmd) + '">' +
            esc(label) + '</a>';
    }

    function miniDisabled(label, title) {
        return '<span title="' + esc(title || "") + '" style="' +
            'display:inline-block;padding:2px 10px;border-radius:999px;background:#e5e7eb;border:2px solid #9ca3af;' +
            'color:#6b7280;font-size:11px;font-weight:900;margin:0 8px 6px 0;opacity:.75;">' + esc(label) + '</span>';
    }

    function doorBits(d) {
        var bits = [];
        bits.push(d.get("isOpen") ? "open" : "closed");
        bits.push(d.get("isLocked") ? "locked" : "unlocked");
        bits.push(d.get("isSecret") ? "secret" : "revealed");
        return bits.join(", ");
    }

    function commitMechanism(mech) {
        if (!mech) return null;
        ensureState().mechanisms[mech.id] = mech;
        return mech;
    }

    function updateSingleMechanism(plateId, mutator) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return null;
        mutator(mech);
        return commitMechanism(mech);
    }

    function updateGroupMechanism(name, createMissing, mutator) {
        var mech = getMultiMechanism(name, createMissing);
        if (!mech) return null;
        mutator(mech);
        return commitMechanism(mech);
    }

    function updateMechanismByRef(ref, mutator) {
        var mech = resolveMechanismRef(ref);
        if (!mech) return null;
        if (mech.kind === "group") {
            if (!requireMechanismConfigEditable(mech.legacyId)) return void 0;
            return updateGroupMechanism(mech.legacyId, false, mutator);
        }
        return updateSingleMechanism(mech.legacyId, mutator);
    }

    function mechanismAddSource(mech, sourceId) {
        for (var i = 0; i < mech.sources.length; i++) {
            if (mech.sources[i] === sourceId) return false;
        }
        mech.sources.push(sourceId);
        if (mech.rule.mode === "single") mech.rule.k = 1;
        return true;
    }

    function mechanismRemoveSource(mech, sourceId) {
        var out = [];
        var removed = false;

        for (var i = 0; i < mech.sources.length; i++) {
            if (mech.sources[i] === sourceId) {
                removed = true;
                continue;
            }
            out.push(mech.sources[i]);
        }

        mech.sources = out;
        if (mech.rule.mode === "all") mech.rule.k = mech.sources.length;
        else if (mech.rule.k > mech.sources.length) mech.rule.k = mech.sources.length;
        if (mech.rule.mode === "single") mech.rule.k = 1;
        return removed;
    }

    function mechanismAddDoor(mech, doorId, mode) {
        mech.effects.doors[doorId] = mode;
    }

    function mechanismRemoveDoor(mech, doorId) {
        delete mech.effects.doors[doorId];
    }

    function describeTeleportDestination(trap) {
        if (!trap || !trap.teleport || !trap.teleport.pageId) return "(not set)";
        return (trap.teleport.name || "Destination") + " @ …" + shortId(trap.teleport.pageId);
    }

    function describePitDestination(trap) {
        if (!trap || !trap.pit || !trap.pit.pageId) return "(not set)";
        return (trap.pit.name || "Pit") + " @ …" + shortId(trap.pit.pageId);
    }

    function describeRevealTargets(trap) {
        var out = [];
        var refs = (trap && trap.revealTargets) ? trap.revealTargets : [];

        for (var i = 0; i < refs.length; i++) {
            var ref = String(refs[i] || "");
            var parts = ref.split(":");
            if (parts.length !== 2) continue;

            var type = parts[0];
            var id = parts[1];
            var obj = getObj(type, id);
            if (!obj) continue;

            if (type === "graphic") {
                out.push((obj.get("name") || "Graphic") + " …" + shortId(id));
            } else if (type === "door") {
                out.push("Door …" + shortId(id));
            }
        }

        return out.length ? out.join(", ") : "(none)";
    }

    function describeSpawnTargets(trap) {
        var out = [];
        var refs = (trap && trap.spawnTargets) ? trap.spawnTargets : [];

        for (var i = 0; i < refs.length; i++) {
            var g = getObj("graphic", refs[i]);
            if (!g) continue;
            out.push((g.get("name") || "Spawn") + " …" + shortId(g.id));
        }

        return out.length ? out.join(", ") : "(none)";
    }

    function describeStatusMarkers(trap) {
        var markers = parseMarkerList(trap && trap.status ? trap.status.markers : "");
        return markers.length ? markers.join(", ") : "(none)";
    }

    /* ---------- commands: singles ---------- */
    function cmdMakePlateFromSelected(msg, plateName, sourceKind) {
        var sel = msg.selected || [];
        sourceKind = String(sourceKind || "pressurePlate");
        if (!SOURCE_KINDS[sourceKind]) sourceKind = "pressurePlate";

        if (!sel.length) {
            whisper("Select one or more trigger tokens or door objects, then run <code>!mech make</code>.");
            return;
        }

        var base = String(plateName || "").trim();
        if (!base) base = "Plate";

        var made = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;

            if (sourceKind === "doorState" && o.get("_type") === "door") {
                made++;
                var newName = base;
                if (sel.length > 1) newName = base + "_" + made;

                getSingleMechanism(o.id);
                updateSingleMechanism(o.id, function (mech) {
                    mech.name = newName;
                    mech.sourceKind = "doorState";
                    mech.pageId = sourcePageId(o, "doorState") || mech.pageId;
                    mech.triggerConfig = backfillTriggerConfig("doorState", mech.triggerConfig);
                    mech.runtime.manualActive = false;
                });
                continue;
            }

            if (sourceKind !== "doorState" && o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                made++;
                o.set({ layer: "gmlayer" });

                var newGraphicName = base;
                if (sel.length > 1) newGraphicName = base + "_" + made;

                o.set({ name: newGraphicName });

                getSingleMechanism(o.id);
                updateSingleMechanism(o.id, function (mech) {
                    mech.sourceKind = sourceKind;
                    mech.triggerConfig = backfillTriggerConfig(sourceKind, mech.triggerConfig);
                    if (sourceKind !== "manual") mech.runtime.manualActive = false;
                });
            }
        }

        if (!made) {
            if (sourceKind === "doorState") whisper("Select one or more Door Tool door objects to create a door-state trigger.");
            else whisper("Select one or more token graphics to create this trigger type.");
            return;
        }

        setUIPage(msg.playerid);
        evaluateAll();
        renderUI(msg.playerid);
    }

    function cmdSetSingleSourceKind(sourceId, sourceKind) {
        sourceKind = String(sourceKind || "").replace(/^\s+|\s+$/g, "");
        if (!SOURCE_KINDS[sourceKind]) {
            whisper("Source type must be <code>pressurePlate</code>, <code>tripwire</code>, <code>proximity</code>, <code>manual</code>, <code>lever</code>, <code>button</code>, or <code>doorState</code>.");
            return;
        }
        if (sourceKind === "doorState" && !getObj("door", sourceId)) {
            whisper("Door-state triggers require a real Roll20 Door Tool door object.");
            return;
        }
        if (sourceKind !== "doorState" && !getObj("graphic", sourceId)) {
            whisper("This trigger is backed by a door object, so it can only use <code>doorState</code>.");
            return;
        }
        updateSingleMechanism(sourceId, function (mech) {
            mech.sourceKind = sourceKind;
            mech.triggerConfig = backfillTriggerConfig(sourceKind, mech.triggerConfig);
            if (!isControlledSourceKind(sourceKind)) mech.runtime.manualActive = false;
        });
        whisper("Trigger …" + esc(shortId(sourceId)) + " source type set to <b>" + esc(sourceKindLabel(sourceKind).toUpperCase()) + "</b>.");
    }

    function cmdSetProximityRange(sourceId, range) {
        range = parseFloat(range, 10);
        if (isNaN(range) || range < 0) range = 1;
        updateSingleMechanism(sourceId, function (mech) {
            mech.sourceKind = "proximity";
            mech.triggerConfig.proximityRange = range;
        });
        whisper("Trigger …" + esc(shortId(sourceId)) + " proximity range set to <b>" + esc(String(range)) + "</b> cell(s).");
    }

    function cmdSetControlledState(sourceId, active, forcedKind) {
        var mech = updateSingleMechanism(sourceId, function (mech) {
            if (forcedKind) mech.sourceKind = forcedKind;
            else if (!isControlledSourceKind(mech.sourceKind)) mech.sourceKind = "manual";
            mech.runtime.manualActive = active;
        });
        evaluateSingleMechanism(sourceId);
        whisper("Trigger …" + esc(shortId(sourceId)) + " " + esc(sourceKindLabel(mech.sourceKind).toLowerCase()) + " state is now <b>" + esc(sourceStateLabel(mech.sourceKind, mech.runtime.manualActive)) + "</b>.");
    }

    function cmdToggleControlledState(sourceId, forcedKind) {
        var mech = updateSingleMechanism(sourceId, function (mech) {
            if (forcedKind) mech.sourceKind = forcedKind;
            else if (!isControlledSourceKind(mech.sourceKind)) mech.sourceKind = "manual";
            mech.runtime.manualActive = !mech.runtime.manualActive;
        });
        evaluateSingleMechanism(sourceId);
        whisper("Trigger …" + esc(shortId(sourceId)) + " " + esc(sourceKindLabel(mech.sourceKind).toLowerCase()) + " state is now <b>" + esc(sourceStateLabel(mech.sourceKind, mech.runtime.manualActive)) + "</b>.");
    }

    function cmdSetManualState(sourceId, active) {
        cmdSetControlledState(sourceId, active, "manual");
    }

    function cmdToggleManualState(sourceId) {
        cmdToggleControlledState(sourceId, "manual");
    }

    function cmdSetLeverState(sourceId, active) {
        cmdSetControlledState(sourceId, active, "lever");
    }

    function cmdToggleLeverState(sourceId) {
        cmdToggleControlledState(sourceId, "lever");
    }

    function cmdSetButtonState(sourceId, active) {
        cmdSetControlledState(sourceId, active, "button");
    }

    function cmdToggleButtonState(sourceId) {
        cmdToggleControlledState(sourceId, "button");
    }

    function cmdSetDoorStateMode(sourceId, mode) {
        mode = String(mode || "").toLowerCase();
        if (!/^(open|closed|locked|unlocked|revealed|hidden)$/.test(mode)) {
            whisper("Door mode must be <code>open</code>, <code>closed</code>, <code>locked</code>, <code>unlocked</code>, <code>revealed</code>, or <code>hidden</code>.");
            return;
        }
        if (!getObj("door", sourceId)) {
            whisper("Door-state triggers require a real Roll20 Door Tool door object.");
            return;
        }
        updateSingleMechanism(sourceId, function (mech) {
            mech.sourceKind = "doorState";
            mech.triggerConfig = backfillTriggerConfig("doorState", mech.triggerConfig);
            mech.triggerConfig.doorStateMode = mode;
            mech.runtime.manualActive = false;
        });
        whisper("Trigger …" + esc(shortId(sourceId)) + " now watches for door state <b>" + esc(doorStateModeLabel(mode).toUpperCase()) + "</b>.");
    }

    function cmdSetMechanismDelay(ref, seconds) {
        var delayMs = Math.round(Math.max(0, parseFloat(seconds, 10) || 0) * 1000);
        var mech = updateMechanismByRef(ref, function (mech) {
            mech.rule.delayMs = delayMs;
            if (delayMs <= 0) clearPendingActivation(mech);
        });
        if (typeof mech === "undefined") return;
        if (!mech) return whisper("Mechanism not found.");
        whisper("Mechanism <b>" + esc(mechanismDisplayName(mech)) + "</b> delay set to <b>" + esc(durationSecondsLabel(delayMs)) + "</b>.");
    }

    function cmdSetMechanismCooldown(ref, seconds) {
        var cooldownMs = Math.round(Math.max(0, parseFloat(seconds, 10) || 0) * 1000);
        var mech = updateMechanismByRef(ref, function (mech) {
            mech.rule.cooldownMs = cooldownMs;
            if (cooldownMs <= 0) mech.runtime.cooldownUntil = 0;
        });
        if (typeof mech === "undefined") return;
        if (!mech) return whisper("Mechanism not found.");
        whisper("Mechanism <b>" + esc(mechanismDisplayName(mech)) + "</b> cooldown set to <b>" + esc(durationSecondsLabel(cooldownMs)) + "</b>.");
    }

    function cmdSetMechanismOneShot(ref, value) {
        value = String(value || "").toLowerCase();
        if (value !== "on" && value !== "off") {
            whisper("One-shot must be <code>on</code> or <code>off</code>.");
            return;
        }
        var mech = updateMechanismByRef(ref, function (mech) {
            mech.rule.oneShot = value === "on";
            if (!mech.rule.oneShot) mech.runtime.oneShotUsed = false;
        });
        if (typeof mech === "undefined") return;
        if (!mech) return whisper("Mechanism not found.");
        whisper("Mechanism <b>" + esc(mechanismDisplayName(mech)) + "</b> one-shot mode is now " + (mech.rule.oneShot ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdResetMechanismRuntime(ref) {
        var mech = updateMechanismByRef(ref, function (mech) {
            clearPendingActivation(mech);
            mech.runtime.lastActive = false;
            mech.runtime.lastConditionActive = false;
            mech.runtime.lastOccupants = [];
            mech.runtime.cooldownUntil = 0;
            mech.runtime.oneShotUsed = false;
            if (mech.kind === "group") {
                mech.locks.hasTriggered = false;
                if (mech.locks.mechanismLocked && mech.locks.freezeWhenLocked) {
                    mech.locks.mechanismLocked = false;
                    mech.locks.freezeWhenLocked = false;
                }
            }
        });
        if (typeof mech === "undefined") return;
        if (!mech) return whisper("Mechanism not found.");
        whisper("Mechanism <b>" + esc(mechanismDisplayName(mech)) + "</b> runtime state has been reset.");
    }

    function cmdAddSingle(msg, mode) {
        mode = (mode || "").toLowerCase();
        if (mode !== "lock" && mode !== "secret") {
            whisper("Use <code>!mech add lock</code> or <code>!mech add secret</code>.");
            return;
        }

        var sel = msg.selected || [];
        var sourceId = "";
        var doors = [];

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (!sourceId && o.get("_type") === "graphic" && o.get("_subtype") === "token" && o.get("layer") === "gmlayer") {
                sourceId = o.id;
                continue;
            }
            if (!sourceId && o.get("_type") === "door" && hasSingleMechanismRecord(o.id) && getSingleMechanism(o.id).sourceKind === "doorState") {
                sourceId = o.id;
                continue;
            }
            if (o.get("_type") === "door") doors.push(o);
        }

        if (sourceId) {
            var filteredDoors = [];
            for (var d0 = 0; d0 < doors.length; d0++) {
                if (doors[d0].id !== sourceId) filteredDoors.push(doors[d0]);
            }
            doors = filteredDoors;
        }

        if (!sourceId) { whisper("Select a trigger source (GM-layer token or an existing door-state trigger) and one or more Door objects."); return; }
        if (!doors.length) { whisper("No Door objects selected (must be Door tool doors)."); return; }

        updateSingleMechanism(sourceId, function (mech) {
            for (var d = 0; d < doors.length; d++) mechanismAddDoor(mech, doors[d].id, mode);
        });

        evaluateSingleMechanism(sourceId);
        renderUI(msg.playerid);
    }

    function cmdSimOpen(plateId) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return;
        for (var doorId in mech.effects.doors) {
            if (!mech.effects.doors.hasOwnProperty(doorId)) continue;
            applyOccupied(getObj("door", doorId), mech.effects.doors[doorId]);
        }
    }

    function cmdSimClose(plateId) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return;
        for (var doorId in mech.effects.doors) {
            if (!mech.effects.doors.hasOwnProperty(doorId)) continue;
            applyUnoccupied(getObj("door", doorId), mech.effects.doors[doorId]);
        }
    }

    function cmdRemoveSingleMechanism(plateId) {
        var st = ensureState();
        unlockTokensForSource(plateId);
        delete st.mechanisms[singleMechanismId(plateId)];

        // Also remove it from any groups
        for (var mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            if (st.mechanisms[mechId].kind !== "group") continue;
            updateGroupMechanism(st.mechanisms[mechId].legacyId, false, function (mech) {
                mechanismRemoveSource(mech, plateId);
            });
        }
    }

    function cmdSetSingleMessageOn(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.messages.on = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " trigger message set.");
    }

    function cmdSetSingleMessageOff(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.messages.off = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " release message set.");
    }

    function cmdEffectToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            var primary = getPrimaryEffect(mech);
            primary.enabled = !primary.enabled;
            if (primary.enabled && primary.type === "none") primary.type = "alarm";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " primary effect is now " + (mech.effects.primary.enabled ? "<b>ENABLED</b>" : "<b>DISABLED</b>") + ".");
    }

    function cmdEffectType(plateId, type) {
        type = String(type || "").toLowerCase();

        if (!PRIMARY_EFFECT_TYPES[type]) {
            whisper("Primary effect must be one of: <code>alarm</code>, <code>damage</code>, <code>projectile</code>, <code>teleport</code>, <code>pit</code>, <code>reveal</code>, <code>save</code>, <code>status</code>, <code>spawn</code>, <code>none</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            var primary = getPrimaryEffect(mech);
            primary.type = type;
            primary.enabled = (type !== "none");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " primary effect set to <b>" + esc(primaryEffectTypeLabel(type).toUpperCase()) + "</b>.");
    }

    function cmdEffectTrigger(plateId, trigger) {
        trigger = String(trigger || "").toLowerCase();

        if (!PRIMARY_EFFECT_TRIGGERS[trigger]) {
            whisper("Primary effect trigger must be <code>press</code>, <code>release</code>, or <code>both</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.rule.timing = trigger;
            getPrimaryEffect(mech).trigger = trigger;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " effect trigger set to <b>" + esc(primaryEffectTriggerLabel(trigger).toUpperCase()) + "</b>.");
    }

    function cmdEffectMessage(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).message = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " effect message set.");
    }

    function cmdEffectDamage(plateId, dmgExpr) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).damage = String(dmgExpr || "").trim() || "1d6";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " damage roll set to <b>" + esc(mech.effects.primary.damage) + "</b>.");
    }

    function cmdEffectProjectileLabel(plateId, label) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).projectile.label = String(label || "").replace(/^\s+|\s+$/g, "") || "Dart volley";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " projectile label set to <b>" + esc(mech.effects.primary.projectile.label) + "</b>.");
    }

    function cmdEffectProjectileDamageType(plateId, dmgType) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).projectile.damageType = String(dmgType || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " projectile damage type set.");
    }

    function cmdEffectSaveLabel(plateId, label) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.label = String(label || "").replace(/^\s+|\s+$/g, "").toUpperCase() || "DEX";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save label set to <b>" + esc(mech.effects.primary.save.label) + "</b>.");
    }

    function cmdEffectSaveDc(plateId, dc) {
        dc = parseInt(dc, 10);
        if (isNaN(dc) || dc < 1) dc = 12;
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.dc = dc;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save DC set to <b>" + esc(String(dc)) + "</b>.");
    }

    function cmdEffectSaveSuccessMsg(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.successMsg = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save success text set.");
    }

    function cmdEffectSaveFailMsg(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.failMsg = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save fail text set.");
    }

    function cmdEffectSaveSuccessMode(plateId, mode) {
        mode = String(mode || "").toLowerCase();
        if (mode !== "half" && mode !== "none") {
            whisper("Save success must be <code>half</code> or <code>none</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.successMode = mode;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save success set to <b>" + esc(mode.toUpperCase()) + "</b>.");
    }

    function cmdEffectSaveDamageType(plateId, dmgType) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.damageType = String(dmgType || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save damage type set.");
    }

    function cmdEffectSaveFailDamage(plateId, dmgExpr) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).save.failDamage = String(dmgExpr || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save fail damage set.");
    }

    function cmdEffectStatusMarkers(plateId, markers) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).status.markers = String(markers || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " status markers set.");
    }

    function cmdEffectStatusClearToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            var primary = getPrimaryEffect(mech);
            primary.status.clearOnRelease = !primary.status.clearOnRelease;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " clear-on-release is now " + (mech.effects.primary.status.clearOnRelease ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdEffectSetTeleport(msg, plateId) {
        var sel = msg.selected || [];
        var marker = null;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.id !== plateId) {
                marker = o;
                break;
            }
        }

        if (!marker) {
            whisper("Select one destination token/graphic, then run <code>!mech effectsetteleport " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).teleport = {
                pageId: marker.get("_pageid"),
                left: marker.get("left"),
                top: marker.get("top"),
                name: marker.get("name") || ("Marker …" + shortId(marker.id))
            };
        });
        whisper("Teleport destination saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectClearTeleport(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).teleport = defaultPrimaryEffectConfig().teleport;
        });
        whisper("Teleport destination cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectSetReveal(msg, plateId) {
        var sel = msg.selected || [];
        var refs = [];

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.id === plateId) continue;

            if (o.get("_type") === "graphic" || o.get("_type") === "door") {
                refs.push(o.get("_type") + ":" + o.id);
            }
        }

        if (!refs.length) {
            whisper("Select one or more hidden graphics or secret doors, then run <code>!mech effectsetreveal " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).revealTargets = refs;
        });
        whisper("Reveal targets saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectClearReveal(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).revealTargets = [];
        });
        whisper("Reveal targets cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectSetSpawn(msg, plateId) {
        var sel = msg.selected || [];
        var ids = [];

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.id === plateId) continue;
            if (o.get("_type") === "graphic") ids.push(o.id);
        }

        if (!ids.length) {
            whisper("Select one or more GM-layer spawn tokens, then run <code>!mech effectsetspawn " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).spawnTargets = ids;
        });
        whisper("Spawn targets saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectClearSpawn(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).spawnTargets = [];
        });
        whisper("Spawn targets cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectSetPitDestination(msg, plateId) {
        var sel = msg.selected || [];
        var marker = null;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.id !== plateId) {
                marker = o;
                break;
            }
        }

        if (!marker) {
            whisper("Select one destination token/graphic, then run <code>!mech effectsetpit " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).pit = {
                pageId: marker.get("_pageid"),
                left: marker.get("left"),
                top: marker.get("top"),
                name: marker.get("name") || ("Pit …" + shortId(marker.id)),
                damage: getPrimaryEffect(mech).pit.damage || "",
                damageType: getPrimaryEffect(mech).pit.damageType || "bludgeoning"
            };
        });
        whisper("Pit / force-move destination saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectClearPitDestination(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).pit.pageId = "";
            getPrimaryEffect(mech).pit.left = 0;
            getPrimaryEffect(mech).pit.top = 0;
            getPrimaryEffect(mech).pit.name = "";
        });
        whisper("Pit / force-move destination cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdEffectPitDamage(plateId, dmgExpr) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).pit.damage = String(dmgExpr || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " pit damage set to <b>" + esc(String(mech.effects.primary.pit.damage || "").trim() || "(none)") + "</b>.");
    }

    function cmdEffectPitDamageType(plateId, dmgType) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).pit.damageType = String(dmgType || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " pit damage type set.");
    }

    function cmdEffectLockToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            var primary = getPrimaryEffect(mech);
            primary.effects.lockToken = !primary.effects.lockToken;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " lock-token effect is now " + (mech.effects.primary.effects.lockToken ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdEffectLockMarker(plateId, marker) {
        updateSingleMechanism(plateId, function (mech) {
            getPrimaryEffect(mech).effects.lockMarker = String(marker || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " lock marker updated.");
    }

    function cmdEffectRevealToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            var primary = getPrimaryEffect(mech);
            primary.effects.revealAlso = !primary.effects.revealAlso;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " reveal effect is now " + (mech.effects.primary.effects.revealAlso ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdEffectUnlock(plateId) {
        var count = unlockTokensForSource(plateId);
        whisper("Unlocked <b>" + esc(String(count)) + "</b> token(s) for trigger …" + esc(shortId(plateId)) + ".");
    }

    function renderEffectUI(playerid, plateId) {
        return renderMechanismEditor(playerid, plateId);
    }

    function resolveMechanismRef(ref) {
        var st = ensureState();
        if (st.mechanisms[ref]) return st.mechanisms[ref];
        if (getObj("graphic", ref)) return getSingleMechanism(ref);
        if (getObj("door", ref)) return getSingleMechanism(ref);
        return getMultiMechanism(ref, false);
    }

    function renderMultiMechanismEditor(playerid, mech) {
        return renderMechanismEditor(playerid, mech.id || mech.legacyId);
    }

    function renderMechanismEditor(playerid, ref) {
        var mech = (typeof ref === "object") ? ref : resolveMechanismRef(ref);
        if (!mech) return whisper("Mechanism not found.");

        backfillMechanismData(mech);

        var isSingle = mech.kind === "single";
        var trap = isSingle ? getPrimaryEffect(mech) : null;
        var sourceId = isSingle ? mech.legacyId : "";
        var sourceObj = isSingle ? getSourceObject(sourceId, mech.sourceKind) : null;
        var singleState = isSingle ? singleMechanismState(mech) : null;
        var active = mechanismIsActive(mech);
        var required = mechanismRequiredCount(mech);
        var pressed = countActiveMechanismSources(mech);
        var overrideActive = (!isSingle) && hasMechanismEditOverride(mech.legacyId);
        var editBlocked = (!isSingle) && mech.locks.configLocked && !overrideActive;
        var cooldownLeft = cooldownRemainingMs(mech);
        var html = "";

        html += "<div style=\"border:2px solid #111;border-radius:12px;overflow:hidden;max-width:760px;font-family:Arial,sans-serif;\">";
        html += "<div style=\"background:#000;color:#fff;padding:10px 12px;\">";
        html += "<div style=\"font-weight:900;font-size:20px;\">Mechanism Configuration</div>";
        html += "<div style=\"color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;\">" + esc(mechanismDisplayName(mech)) + " • " + esc(mechanismRuleSummary(mech)) + "</div>";
        html += "</div>";
        html += "<div style=\"background:#fff;padding:10px;\">";

        html += "<div style=\"border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;\">";
        html += badge(active ? "ACTIVE" : "INACTIVE", active);
        html += badge(isSingle ? "SINGLE" : "MULTI", false);
        if (isSingle) html += badge((trap.enabled && trap.type !== "none") ? "PRIMARY EFFECT" : "NO PRIMARY EFFECT", false);
        if (!isSingle && mech.locks.mechanismLocked) html += badge(mech.locks.freezeWhenLocked ? "FROZEN" : "LOCKED", false);
        if (!isSingle && mech.locks.configLocked) html += badge("CONFIG", false);
        if (overrideActive) html += badge("OVERRIDE", true);
        if (!isSingle && mech.locks.autoLock) html += badge("AUTOLOCK", true);
        html += "<div style=\"margin-top:8px;\">";
        html += iconBtn("↩️", "!mech ui", "Back to mechanism list");
        html += iconBtn("🔄", "!mech edit " + mech.legacyId, "Refresh mechanism configuration");
        if (isSingle) {
            html += iconBtn("🔍", "!mech ping " + sourceId, "Ping trigger");
            html += iconBtn("✅", "!mech checkplate " + sourceId, "Check mechanism");
            html += iconBtn("⬆️", "!mech simopen " + sourceId, "Force open (simulate triggered)");
            html += iconBtn("⬇️", "!mech simclose " + sourceId, "Force close (simulate released)");
            html += iconBtn("🗑️", "!mech removeplate " + sourceId, "Remove mechanism");
        } else {
            html += iconBtn("✅", "!mech groupcheck " + mech.legacyId, "Check mechanism");
            if (editBlocked) html += iconBtnDisabled("🗑️", "Config locked");
            else html += iconBtn("🗑️", "!mech groupremove " + mech.legacyId, "Remove mechanism");
        }
        if (isSingle) {
            html += iconBtn("💣", "!mech effecttoggle " + sourceId, (trap.enabled && trap.type !== "none") ? "Disable primary effect" : "Enable primary effect");
            html += iconBtn("🔁", "!mech reset " + sourceId, "Reset mechanism runtime");
        } else {
            html += iconBtn(mech.locks.mechanismLocked ? "🔒" : "🔓", "!mech grouplock " + mech.legacyId, "Toggle mechanism lock");
            html += iconBtn(mech.locks.configLocked ? "🧱" : "✏️", "!mech groupcfglock " + mech.legacyId, "Toggle config lock");
            html += iconBtn(mech.locks.autoLock ? "⭐" : "☆", "!mech groupautolock " + mech.legacyId, "Toggle auto-lock after first trigger");
            html += iconBtn("🔁", "!mech reset " + mech.legacyId, "Reset mechanism runtime");
        }
        html += "</div>";
        if (isSingle) {
            html += "<div style=\"margin-top:8px;font-weight:900;\">Source type: <span style=\"color:#333;\">" + esc(sourceKindLabel(mech.sourceKind)) + "</span></div>";
            html += "<div style=\"margin-top:4px;font-weight:900;\">State: <span style=\"color:#333;\">" + esc(sourceStateLabel(mech.sourceKind, singleState.active)) + "</span></div>";
            html += "<div style=\"margin-top:4px;font-weight:900;\">Source: <span style=\"color:#333;\">" + esc(sourceDisplayName(sourceId, mech.sourceKind, sourceObj)) + "</span></div>";
        } else if (!isSingle) {
            html += "<div style=\"margin-top:8px;font-weight:900;\">Pressed: <span style=\"color:#333;\">" + esc(String(pressed)) + "/" + esc(String(required)) + "</span></div>";
        }
        if (mech.rule.oneShot) html += "<div style=\"margin-top:4px;font-weight:900;\">One-shot used: <span style=\"color:#333;\">" + esc(mech.runtime.oneShotUsed ? "YES" : "NO") + "</span></div>";
        if (cooldownLeft > 0) html += "<div style=\"margin-top:4px;font-weight:900;\">Cooldown: <span style=\"color:#333;\">" + esc(durationSecondsLabel(cooldownLeft)) + " remaining</span></div>";
        if (mech.runtime.pendingUntil > Date.now()) html += "<div style=\"margin-top:4px;font-weight:900;\">Pending: <span style=\"color:#333;\">Activates in " + esc(durationSecondsLabel(mech.runtime.pendingUntil - Date.now())) + "</span></div>";
        html += "</div>";

        if (!isSingle) {
            html += "<div style=\"border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;\">";
            html += "<div style=\"font-weight:900;font-size:16px;margin-bottom:6px;\">Locking</div>";
            html += "<div style=\"margin-top:4px;font-weight:900;\">Mechanism lock: <span style=\"color:#333;\">" + esc(mech.locks.mechanismLocked ? (mech.locks.freezeWhenLocked ? "FROZEN" : "LOCKED") : "UNLOCKED") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Config lock: <span style="color:#333;">' + esc(mech.locks.configLocked ? "LOCKED" : "UNLOCKED") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Auto-lock: <span style="color:#333;">' + esc(mech.locks.autoLock ? "ON" : "OFF") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Override: <span style="color:#333;">' + esc(overrideActive ? "ACTIVE" : "INACTIVE") + "</span></div>";
            html += "</div>";
        }

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Messages</div>';
        if (isSingle) {
            html += mini("Set On", "!mech platemsgon " + sourceId + " ?{Trigger message|}", "Set trigger message");
            html += mini("Set Off", "!mech platemsgoff " + sourceId + " ?{Release message|}", "Set release message");
        } else if (editBlocked) {
            html += miniDisabled("Set On", "Config locked");
            html += miniDisabled("Set Off", "Config locked");
        } else {
            html += mini("Set On", "!mech groupmsgon " + mech.legacyId + " ?{Trigger message|}", "Set trigger message");
            html += mini("Set Off", "!mech groupmsgoff " + mech.legacyId + " ?{Release message|}", "Set release message");
        }
        html += '<div style="margin-top:8px;font-weight:900;">On: <span style="color:#333;">' + esc(mech.messages.on || "(none)") + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Off: <span style="color:#333;">' + esc(mech.messages.off || "(none)") + "</span></div>";
        if (isSingle) {
            html += '<div style="margin-top:8px;font-weight:900;">Primary effect message: <span style="color:#333;">' + esc(String(trap.message || "").trim() || "(none)") + "</span></div>";
            html += mini("Set effect message", "!mech effectmsg " + sourceId + " ?{Effect message|}", "Set primary effect narration");
        }
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Rule</div>';
        if (isSingle) {
            html += mini("Press", "!mech effecttrigger " + sourceId + " press", "Fire on press");
            html += mini("Release", "!mech effecttrigger " + sourceId + " release", "Fire on release");
            html += mini("Both", "!mech effecttrigger " + sourceId + " both", "Fire on press and release");
        } else if (editBlocked) {
            html += miniDisabled("Require ALL", "Config locked");
            html += miniDisabled("Set K", "Config locked");
        } else {
            html += mini("Require ALL", "!mech groupsetall " + mech.legacyId, "Require all sources");
            html += mini("Set K", "!mech groupsetk " + mech.legacyId + " ?{Require how many sources?|2}", "Set K-of-N");
        }
        if (!editBlocked || isSingle) {
            html += mini("Set delay", "!mech ruledelay " + (isSingle ? sourceId : mech.legacyId) + " ?{Delay in seconds|0}", "Delay activation");
            html += mini("Set cooldown", "!mech rulecooldown " + (isSingle ? sourceId : mech.legacyId) + " ?{Cooldown in seconds|0}", "Cooldown after activation");
            html += mini(mech.rule.oneShot ? "One-shot OFF" : "One-shot ON", "!mech ruleoneshot " + (isSingle ? sourceId : mech.legacyId) + " " + (mech.rule.oneShot ? "off" : "on"), "Toggle one-shot");
            html += mini("Reset", "!mech reset " + (isSingle ? sourceId : mech.legacyId), "Reset one-shot, cooldown, and pending state");
        } else {
            html += miniDisabled("Set delay", "Config locked");
            html += miniDisabled("Set cooldown", "Config locked");
            html += miniDisabled("One-shot", "Config locked");
            html += miniDisabled("Reset", "Config locked");
        }
        html += '<div style="margin-top:8px;font-weight:900;">Current: <span style="color:#333;">' + esc(mechanismRuleSummary(mech)) + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Delay: <span style="color:#333;">' + esc(durationSecondsLabel(mech.rule.delayMs)) + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Cooldown: <span style="color:#333;">' + esc(durationSecondsLabel(mech.rule.cooldownMs)) + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">One-shot: <span style="color:#333;">' + esc(mech.rule.oneShot ? "ON" : "OFF") + "</span></div>";
        html += "</div>";

        if (isSingle) {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Trigger Type</div>';
            if (getObj("graphic", sourceId)) {
                html += mini("Pressure Plate", "!mech sourcetype " + sourceId + " pressurePlate", "Require full occupancy");
                html += mini("Tripwire", "!mech sourcetype " + sourceId + " tripwire", "Trigger on any overlap");
                html += mini("Proximity", "!mech sourcetype " + sourceId + " proximity", "Trigger when tokens enter a radius");
                html += mini("Manual", "!mech sourcetype " + sourceId + " manual", "GM-controlled trigger state");
                html += mini("Lever", "!mech sourcetype " + sourceId + " lever", "GM-controlled lever state");
                html += mini("Button", "!mech sourcetype " + sourceId + " button", "GM-controlled button state");
            }
            if (getObj("door", sourceId)) {
                html += mini("Door State", "!mech sourcetype " + sourceId + " doorState", "Fire when the Door Tool object matches a state");
            }
            html += '<div style="margin-top:8px;font-weight:900;">Current: <span style="color:#333;">' + esc(sourceKindLabel(mech.sourceKind)) + "</span></div>";
            if (mech.sourceKind === "proximity") {
                html += mini("Set range", "!mech proximityrange " + sourceId + " ?{Range in cells|1}", "Set proximity radius");
                html += '<div style="margin-top:4px;font-weight:900;">Range: <span style="color:#333;">' + esc(String(mech.triggerConfig.proximityRange)) + " cell(s)</span></div>";
            }
            if (mech.sourceKind === "manual") {
                html += mini("Activate", "!mech manualon " + sourceId, "Set manual trigger active");
                html += mini("Deactivate", "!mech manualoff " + sourceId, "Set manual trigger inactive");
                html += mini("Toggle", "!mech manualtoggle " + sourceId, "Toggle manual trigger state");
            }
            if (mech.sourceKind === "lever") {
                html += mini("Switch On", "!mech leveron " + sourceId, "Flip lever on");
                html += mini("Switch Off", "!mech leveroff " + sourceId, "Flip lever off");
                html += mini("Toggle", "!mech levertoggle " + sourceId, "Toggle lever state");
            }
            if (mech.sourceKind === "button") {
                html += mini("Press", "!mech buttonpress " + sourceId, "Press the button");
                html += mini("Release", "!mech buttonrelease " + sourceId, "Release the button");
                html += mini("Toggle", "!mech buttontoggle " + sourceId, "Toggle button state");
            }
            if (mech.sourceKind === "doorState") {
                html += mini("On Open", "!mech doorstatemode " + sourceId + " open", "Fire when the door is open");
                html += mini("On Closed", "!mech doorstatemode " + sourceId + " closed", "Fire when the door is closed");
                html += mini("On Locked", "!mech doorstatemode " + sourceId + " locked", "Fire when the door is locked");
                html += mini("On Unlocked", "!mech doorstatemode " + sourceId + " unlocked", "Fire when the door is unlocked");
                html += mini("On Revealed", "!mech doorstatemode " + sourceId + " revealed", "Fire when the door is revealed");
                html += mini("On Hidden", "!mech doorstatemode " + sourceId + " hidden", "Fire when the door is hidden");
                html += '<div style="margin-top:4px;font-weight:900;">Watch for: <span style="color:#333;">' + esc(doorStateModeLabel(mech.triggerConfig.doorStateMode)) + "</span></div>";
            }
            html += "</div>";
        }

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Sources</div>';
        if (!isSingle) {
            if (editBlocked) html += miniDisabled("Add selected sources", "Config locked");
            else html += mini("Add selected sources", "!mech groupaddplates " + mech.legacyId, "Add selected sources");
        }
        for (var i = 0; i < mech.sources.length; i++) {
            var srcMech = getSingleMechanism(mech.sources[i]);
            var src = getSourceObject(srcMech.legacyId, srcMech.sourceKind);
            if (!src) continue;
            html += '<div style="margin-top:6px;font-weight:900;">' + esc(sourceDisplayName(srcMech.legacyId, srcMech.sourceKind, src)) + ' ';
            html += '<span style="color:#666;">(' + esc(sourceKindLabel(srcMech.sourceKind)) + ')</span> ';
            html += mini("Ping", "!mech ping " + srcMech.legacyId, "Ping source");
            if (!isSingle) {
                if (editBlocked) html += miniDisabled("Remove", "Config locked");
                else html += mini("Remove", "!mech groupdelplate " + mech.legacyId + " " + srcMech.legacyId, "Remove source");
            }
            html += "</div>";
        }
        if (!mech.sources.length) html += '<div style="margin-top:6px;color:#666;font-weight:900;">(No sources)</div>';
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Doors</div>';
        if (isSingle) {
            html += mini("Bind LOCK doors", "!mech add lock", "Select this source and doors, then click");
            html += mini("Bind SECRET doors", "!mech add secret", "Select this source and doors, then click");
        } else if (editBlocked) {
            html += miniDisabled("Add LOCK", "Config locked");
            html += miniDisabled("Add SECRET", "Config locked");
        } else {
            html += mini("Add LOCK", "!mech groupadddoors " + mech.legacyId + " lock", "Bind selected doors as lock");
            html += mini("Add SECRET", "!mech groupadddoors " + mech.legacyId + " secret", "Bind selected doors as secret");
        }
        for (var doorId in mech.effects.doors) {
            if (!mech.effects.doors.hasOwnProperty(doorId)) continue;
            html += '<div style="margin-top:6px;font-weight:900;">' + esc(String(mech.effects.doors[doorId]).toUpperCase()) + " door …" + esc(shortId(doorId)) + " ";
            if (!isSingle) {
                if (editBlocked) html += miniDisabled("Detach", "Config locked");
                else html += mini("Detach", "!mech groupdeldor " + mech.legacyId + " " + doorId, "Detach door");
            }
            html += "</div>";
        }
        if (!Object.keys(mech.effects.doors).length) html += '<div style="margin-top:6px;color:#666;font-weight:900;">(No doors)</div>';
        html += "</div>";

        if (isSingle) {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Primary Effect</div>';
            html += mini("Alarm", "!mech effecttype " + sourceId + " alarm", "Narration or warning effect");
            html += mini("Damage", "!mech effecttype " + sourceId + " damage", "Damage effect");
            html += mini("Projectile", "!mech effecttype " + sourceId + " projectile", "Projectile-style damage effect");
            html += mini("Save", "!mech effecttype " + sourceId + " save", "Save/check prompt effect");
            html += mini("Status", "!mech effecttype " + sourceId + " status", "Apply status markers");
            html += mini("Spawn", "!mech effecttype " + sourceId + " spawn", "Reveal selected spawn tokens");
            html += mini("Teleport", "!mech effecttype " + sourceId + " teleport", "Teleport occupants");
            html += mini("Pit / Move", "!mech effecttype " + sourceId + " pit", "Force-move or pit effect");
            html += mini("Reveal", "!mech effecttype " + sourceId + " reveal", "Reveal hidden targets");
            html += mini("Disable", "!mech effecttype " + sourceId + " none", "Disable primary effect without removing mechanism");
            html += '<div style="margin-top:8px;font-weight:900;">Current type: <span style="color:#333;">' + esc(primaryEffectTypeLabel(trap.type)) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Effects: <span style="color:#333;">' + esc(mechanismEffectSummary(mech)) + "</span></div>";
            html += "</div>";

            if (trap.type === "damage") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Damage</div>';
                html += mini("Set damage", "!mech effectdamage " + sourceId + " ?{Damage roll|1d6}", "Set damage roll");
                html += '<div style="margin-top:8px;font-weight:900;">Damage: <span style="color:#333;">' + esc(trap.damage) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "projectile") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Projectile</div>';
                html += mini("Set label", "!mech effectprojectilename " + sourceId + " ?{Projectile label|Dart volley}", "Set projectile label");
                html += mini("Set damage", "!mech effectdamage " + sourceId + " ?{Damage roll|1d6}", "Set damage roll");
                html += mini("Set dmg type", "!mech effectprojectiledmgtype " + sourceId + " ?{Damage type|piercing|slashing|bludgeoning|acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder}", "Set projectile damage type");
                html += '<div style="margin-top:8px;font-weight:900;">Label: <span style="color:#333;">' + esc(String(trap.projectile.label || "").trim() || "(none)") + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Damage: <span style="color:#333;">' + esc(trap.damage) + damageTypeSuffix(trap.projectile.damageType) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "save") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Save</div>';
                html += mini("Set label", "!mech effectsavelabel " + sourceId + " ?{Save label|DEX}", "Set save label");
                html += mini("Set DC", "!mech effectsavedc " + sourceId + " ?{Save DC|12}", "Set save DC");
                html += mini("Set success text", "!mech effectsavesuccessmsg " + sourceId + " ?{Success text|}", "Set success text");
                html += mini("Set fail text", "!mech effectsavefailmsg " + sourceId + " ?{Fail text|}", "Set fail text");
                html += mini("Success HALF", "!mech effectsavesuccess " + sourceId + " half", "Success takes half damage");
                html += mini("Success NONE", "!mech effectsavesuccess " + sourceId + " none", "Success takes no damage");
                html += mini("Set dmg type", "!mech effectsavedmgtype " + sourceId + " ?{Damage type|piercing|slashing|bludgeoning|acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder}", "Set damage type");
                html += mini("Set fail damage", "!mech effectsavefaildmg " + sourceId + " ?{Fail damage|1d6}", "Set fail damage");
                html += '<div style="margin-top:8px;font-weight:900;">Save: <span style="color:#333;">' + esc(String(trap.save.label).toUpperCase()) + " DC " + esc(String(trap.save.dc)) + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Success result: <span style="color:#333;">' + esc(String(trap.save.successMode || "none").toUpperCase()) + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Damage type: <span style="color:#333;">' + esc(String(trap.save.damageType || "").trim() || "(none)") + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Fail damage: <span style="color:#333;">' + esc(String(trap.save.failDamage || "").trim() || "(none)") + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "status") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Status</div>';
                html += mini("Set markers", "!mech effectstatusmarkers " + sourceId + " ?{Markers (comma-separated)|cobweb}", "Set markers");
                html += mini(trap.status.clearOnRelease ? "Clear on release: ON" : "Clear on release: OFF", "!mech effectstatusclear " + sourceId, "Toggle clear on release");
                html += '<div style="margin-top:8px;font-weight:900;">Markers: <span style="color:#333;">' + esc(describeStatusMarkers(trap)) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "teleport") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Teleport</div>';
                html += mini("Set destination", "!mech effectsetteleport " + sourceId, "Set destination from selection");
                html += mini("Clear destination", "!mech effectclearteleport " + sourceId, "Clear destination");
                html += '<div style="margin-top:8px;font-weight:900;">Destination: <span style="color:#333;">' + esc(describeTeleportDestination(trap)) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "pit") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Pit / Force Move</div>';
                html += mini("Set destination", "!mech effectsetpit " + sourceId, "Set pit or force-move destination from selection");
                html += mini("Clear destination", "!mech effectclearpit " + sourceId, "Clear pit destination");
                html += mini("Set damage", "!mech effectpitdamage " + sourceId + " ?{Pit damage|}", "Set optional pit damage");
                html += mini("Set dmg type", "!mech effectpitdmgtype " + sourceId + " ?{Damage type|bludgeoning|piercing|slashing|acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder}", "Set pit damage type");
                html += '<div style="margin-top:8px;font-weight:900;">Destination: <span style="color:#333;">' + esc(describePitDestination(trap)) + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Damage: <span style="color:#333;">' + esc(String(trap.pit.damage || "").trim() || "(none)") + damageTypeSuffix(trap.pit.damageType) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "reveal" || trap.type === "spawn") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Effect Targets</div>';
                if (trap.type === "reveal") {
                    html += mini("Set reveal targets", "!mech effectsetreveal " + sourceId, "Set reveal targets from selection");
                    html += mini("Clear reveal targets", "!mech effectclearreveal " + sourceId, "Clear reveal targets");
                    html += '<div style="margin-top:8px;font-weight:900;">Reveal targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
                } else {
                    html += mini("Set spawn targets", "!mech effectsetspawn " + sourceId, "Set spawn targets from selection");
                    html += mini("Clear spawn targets", "!mech effectclearspawn " + sourceId, "Clear spawn targets");
                    html += '<div style="margin-top:8px;font-weight:900;">Spawn targets: <span style="color:#333;">' + esc(describeSpawnTargets(trap)) + "</span></div>";
                }
                html += "</div>";
            }

            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Extra Effects</div>';
            if (trap.type !== "reveal") html += mini(trap.effects.revealAlso ? "Reveal targets: ON" : "Reveal targets: OFF", "!mech effectrevealtoggle " + sourceId, "Toggle reveal effect");
            html += mini("Set reveal targets", "!mech effectsetreveal " + sourceId, "Set reveal targets");
            html += mini("Clear reveal targets", "!mech effectclearreveal " + sourceId, "Clear reveal targets");
            html += mini(trap.effects.lockToken ? "Lock token: ON" : "Lock token: OFF", "!mech effectlocktoggle " + sourceId, "Toggle lock token effect");
            html += mini("Set lock marker", "!mech effectlockmarker " + sourceId + " ?{Lock marker|fishing-net}", "Set lock marker");
            html += mini("Unlock tokens", "!mech effectunlock " + sourceId, "Unlock affected tokens");
            html += '<div style="margin-top:8px;font-weight:900;">Reveal targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Lock effect: <span style="color:#333;">' + esc(trap.effects.lockToken ? "ON" : "OFF") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Lock marker: <span style="color:#333;">' + esc(String(trap.effects.lockMarker || "").trim() || "(none)") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Locked tokens: <span style="color:#333;">' + esc(String(lockedCountForSource(sourceId))) + "</span></div>";
            html += "</div>";
        }

        html += "</div></div>";
        whisper(html);
    }

    /* ---------- commands: groups ---------- */
    function cmdCreateMultiMechanismFromSelected(msg, name, required) {
        if (!name) { whisper("Usage: <code>!mech groupmake NAME [K]</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        required = parseInt(required, 10);
        if (isNaN(required) || required < 0) required = 0;
        var mech = getMultiMechanism(name, true);
        mech.rule.mode = required === 0 ? "all" : "kofn";
        mech.rule.k = required === 0 ? mech.sources.length : required;

        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                getSingleMechanism(o.id);
                if (mechanismAddSource(mech, o.id)) added++;
                continue;
            }
            if (o.get("_type") === "door") {
                getSingleMechanism(o.id);
                updateSingleMechanism(o.id, function (singleMech) {
                    singleMech.sourceKind = "doorState";
                    singleMech.triggerConfig = backfillTriggerConfig("doorState", singleMech.triggerConfig);
                });
                if (mechanismAddSource(mech, o.id)) added++;
            }
        }

        if (mech.rule.mode === "all") mech.rule.k = mech.sources.length;
        commitMechanism(mech);
        whisper("Group <b>" + esc(name) + "</b> updated. Added <b>" + esc(String(added)) + "</b> source(s).");
    }

    function cmdAddSourcesToMultiMechanism(msg, name) {
        if (!name) { whisper("Usage: <code>!mech groupaddplates NAME</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        var mech = getMultiMechanism(name, true);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                getSingleMechanism(o.id);
                if (mechanismAddSource(mech, o.id)) added++;
                continue;
            }
            if (o.get("_type") === "door") {
                getSingleMechanism(o.id);
                updateSingleMechanism(o.id, function (singleMech) {
                    singleMech.sourceKind = "doorState";
                    singleMech.triggerConfig = backfillTriggerConfig("doorState", singleMech.triggerConfig);
                });
                if (mechanismAddSource(mech, o.id)) added++;
            }
        }

        if (mech.rule.mode === "all") mech.rule.k = mech.sources.length;
        commitMechanism(mech);
        whisper("Added <b>" + esc(String(added)) + "</b> source(s) to group <b>" + esc(name) + "</b>.");
    }

    function cmdAddDoorsToMultiMechanism(msg, name, mode) {
        if (!name) { whisper("Usage: <code>!mech groupadddoors NAME lock|secret</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        mode = (mode || "").toLowerCase();
        if (mode !== "lock" && mode !== "secret") {
            whisper("Usage: select Door object(s), then <code>!mech groupadddoors " + esc(name) + " lock</code> or <code>... secret</code>.");
            return;
        }

        var mech = getMultiMechanism(name, true);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "door") {
                mechanismAddDoor(mech, o.id, mode);
                added++;
            }
        }

        commitMechanism(mech);
        whisper("Added <b>" + esc(String(added)) + "</b> door(s) to group <b>" + esc(name) + "</b> as <b>" + esc(mode.toUpperCase()) + "</b>.");
    }

    function cmdSetMultiMechanismRequireAll(name) {
        if (!requireMechanismConfigEditable(name)) return;
        updateGroupMechanism(name, true, function (mech) {
            mech.rule.mode = "all";
            mech.rule.k = mech.sources.length;
        });
        whisper("Group <b>" + esc(name) + "</b> now requires <b>ALL</b> plates.");
    }

    function cmdSetMultiMechanismRequiredCount(name, k) {
        if (!requireMechanismConfigEditable(name)) return;
        k = parseInt(k, 10);
        if (isNaN(k) || k < 1) { whisper("K must be a number >= 1."); return; }
        updateGroupMechanism(name, true, function (mech) {
            mech.rule.mode = "kofn";
            mech.rule.k = k;
        });
        whisper("Group <b>" + esc(name) + "</b> now requires <b>" + esc(String(k)) + "</b> plate(s).");
    }

    // Trigger lock toggle
    function cmdToggleMechanismLock(name) {
        var mech = updateGroupMechanism(name, false, function (mech) {
            if (mech.locks.mechanismLocked && mech.locks.freezeWhenLocked) mech.locks.freezeWhenLocked = false;
            mech.locks.mechanismLocked = !mech.locks.mechanismLocked;
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        whisper("Group <b>" + esc(name) + "</b> is now " + (mech.locks.mechanismLocked ? "<b>LOCKED</b> (mechanism disabled)" : "<b>UNLOCKED</b>") + ".");
    }

    // Config lock toggle
    function cmdToggleMechanismConfigLock(name) {
        var st = ensureState();
        var mech = updateGroupMechanism(name, false, function (mech) {
            mech.locks.configLocked = !mech.locks.configLocked;
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        if (mech.locks.configLocked) delete st.editOverride[name];
        whisper("Group <b>" + esc(name) + "</b> config is now " + (mech.locks.configLocked ? "<b>CONFIG LOCKED</b>" : "<b>CONFIG UNLOCKED</b>") + ".");
    }

    // GM override for config lock (60s)
    function cmdEnableMechanismOverride(name) {
        var st = ensureState();
        var mech = getMultiMechanism(name, false);
        if (!mech) return whisper("Group not found: " + esc(name));

        st.editOverride[name] = Date.now() + OVERRIDE_MS;
        whisper("Override enabled for group <b>" + esc(name) + "</b> for <b>60 seconds</b>.");
    }

    // Auto-lock toggle
    function cmdToggleMechanismAutoLock(name) {
        if (!requireMechanismConfigEditable(name)) return;

        var mech = updateGroupMechanism(name, false, function (mech) {
            mech.locks.autoLock = !mech.locks.autoLock;
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        whisper("Group <b>" + esc(name) + "</b> Auto-lock after first trigger is now " + (mech.locks.autoLock ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdResetMechanismTriggerState(name) {
        cmdResetMechanismRuntime(name);
    }

    function cmdRemoveMultiMechanism(name) {
        var st = ensureState();
        delete st.mechanisms[multiMechanismId(name)];
        delete st.editOverride[name];
        whisper("Removed group <b>" + esc(name) + "</b>.");
    }

    function cmdRemoveSourceFromMultiMechanism(name, plateId) {
        if (!requireMechanismConfigEditable(name)) return;
        var mech = updateGroupMechanism(name, false, function (mech) {
            mechanismRemoveSource(mech, plateId);
        });
        if (!mech) return;
        whisper("Removed plate …" + esc(shortId(plateId)) + " from group <b>" + esc(name) + "</b>.");
    }

    function cmdRemoveDoorFromMultiMechanism(name, doorId) {
        if (!requireMechanismConfigEditable(name)) return;
        var mech = updateGroupMechanism(name, false, function (mech) {
            mechanismRemoveDoor(mech, doorId);
        });
        if (!mech) return;
        whisper("Detached door …" + esc(shortId(doorId)) + " from group <b>" + esc(name) + "</b>.");
    }

    function cmdSetMultiMechanismMessageOn(name, msgText) {
        if (!requireMechanismConfigEditable(name)) return;
        updateGroupMechanism(name, true, function (mech) {
            mech.messages.on = String(msgText || "");
        });
        whisper("Group <b>" + esc(name) + "</b> trigger message set.");
    }

    function cmdSetMultiMechanismMessageOff(name, msgText) {
        if (!requireMechanismConfigEditable(name)) return;
        updateGroupMechanism(name, true, function (mech) {
            mech.messages.off = String(msgText || "");
        });
        whisper("Group <b>" + esc(name) + "</b> release message set.");
    }

    function mechanismDisplayName(mech) {
        return mech.name || ("Mechanism …" + shortId(mech.id));
    }

    function mechanismVisibleOnPage(mech, pageId) {
        if (!mech) return false;
        if (mech.pageId && mech.pageId === pageId) return true;

        for (var i = 0; i < mech.sources.length; i++) {
            var sourceMech = getSingleMechanism(mech.sources[i]);
            var source = getSourceObject(sourceMech.legacyId, sourceMech.sourceKind);
            if (source && sourcePageId(source, sourceMech.sourceKind) === pageId) return true;
        }
        return false;
    }

    function mechanismRequiredCount(mech) {
        if (!mech) return 0;
        if (mech.rule.mode === "all") return mech.sources.length;
        if (mech.rule.mode === "single") return 1;
        return mech.rule.k;
    }

    function mechanismIsActive(mech) {
        if (!mech) return false;
        if (mech.kind === "single") {
            return singleMechanismState(mech).active;
        }
        if (mech.locks.mechanismLocked) return false;
        var required = mechanismRequiredCount(mech);
        return mech.sources.length > 0 && countActiveMechanismSources(mech) >= required;
    }

    function mechanismRuleSummary(mech) {
        var base;
        var extras = mechanismRuleExtras(mech);
        if (!mech) return "";
        if (mech.kind === "single") {
            base = sourceKindLabel(mech.sourceKind) + " / " + primaryEffectTriggerLabel(mech.rule.timing);
        } else {
            var required = mechanismRequiredCount(mech);
            base = required + " of " + mech.sources.length + " / " + primaryEffectTriggerLabel(mech.rule.timing);
        }
        if (extras.length) base += " / " + extras.join(" / ");
        return base;
    }

    function mechanismEffectSummary(mech) {
        var parts = [];
        var doorCount = Object.keys(mech.effects.doors || {}).length;
        var trap = mech.effects.primary;
        var trapEnabled = trap && trap.enabled && trap.type !== "none";

        if (doorCount) parts.push(doorCount + " door" + (doorCount === 1 ? "" : "s"));
        if (trapEnabled) parts.push(primaryEffectTypeLabel(trap.type));

        return parts.length ? parts.join(" + ") : "(no effects)";
    }

    function sortMechanismsForUi(a, b) {
        if (a.kind !== b.kind) return a.kind === "single" ? -1 : 1;
        var an = mechanismDisplayName(a).toLowerCase();
        var bn = mechanismDisplayName(b).toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
    }

    /* ---------- UI rendering ---------- */
    function renderUI(playerid) {
        var st = ensureState();
        var pageId = getUIPage(playerid);
        var pageName = getUIPageName(pageId);
        var suggested = safeGroupNameFromPage(pageName);
        var mechs = [];
        var mechId;

        pruneAllMechanisms();
        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            if (!mechanismVisibleOnPage(st.mechanisms[mechId], pageId)) continue;
            mechs.push(st.mechanisms[mechId]);
        }
        mechs.sort(sortMechanismsForUi);

        var html = "";
        html += '<div style="border:2px solid #111;border-radius:12px;overflow:hidden;max-width:860px;font-family:Arial,sans-serif;">';

        // header
        html += '<div style="background:#000;color:#fff;padding:10px 12px;">';
        html += '<div style="font-weight:900;font-size:20px;">Mechanism List</div>';
        html += '<div style="color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;">UI Page: ' + esc(pageName) + ' (…' + esc(shortId(pageId)) + ')</div>';
        html += "</div>";

        // body
        html += '<div style="background:#fff;padding:10px;">';

        // global controls
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Controls</div>';
        html += iconBtn("🧱", "!mech make ?{Trigger name|Pressure_Plate} pressurePlate", "Create pressure plate from selected trigger");
        html += iconBtn("🪤", "!mech make ?{Trigger name|Tripwire} tripwire", "Create tripwire from selected trigger");
        html += iconBtn("📡", "!mech make ?{Trigger name|Proximity_Zone} proximity", "Create proximity trigger from selected token");
        html += iconBtn("🎛️", "!mech make ?{Trigger name|Manual_Trigger} manual", "Create manual trigger from selected token");
        html += iconBtn("🎚️", "!mech make ?{Trigger name|Lever} lever", "Create a lever trigger from selected token");
        html += iconBtn("🔘", "!mech make ?{Trigger name|Button} button", "Create a button trigger from selected token");
        html += iconBtn("🚪", "!mech make ?{Trigger name|Door_Trigger} doorState", "Create a door-state trigger from selected Door Tool doors");
        html += iconBtn("🧭", "!mech setpage", "Use Current Page (Set)");
        html += iconBtn("🔄", "!mech ui", "Refresh UI");
        html += iconBtn("✅", "!mech check", "Force check all mechanisms");
        html += "</div>";

        // multi-source builder
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Multi-Source Builder</div>';
        html += '<div style="color:#333;font-weight:900;margin-bottom:8px;">Suggested name: <span style="font-family:monospace;">' + esc(suggested) + "</span></div>";

        html += mini("Create from selected triggers", "!mech groupmake ?{Mechanism Name (no spaces)|" + esc(suggested) + "} ?{Required K (0=ALL)|0}", "Create or update a multi-source mechanism");
        html += mini("Add selected triggers", "!mech groupaddplates ?{Mechanism Name (no spaces)|" + esc(suggested) + "}", "Add selected triggers to an existing mechanism");
        html += mini("Add selected LOCK doors", "!mech groupadddoors ?{Mechanism Name (no spaces)|" + esc(suggested) + "} lock", "Bind selected door(s) as LOCK effects");
        html += mini("Add selected SECRET doors", "!mech groupadddoors ?{Mechanism Name (no spaces)|" + esc(suggested) + "} secret", "Bind selected door(s) as SECRET effects");
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;margin-bottom:12px;">';
        html += '<div style="padding:8px 10px;border-bottom:2px solid #111;background:#f3f4f6;">';
        html += '<span style="font-weight:900;font-size:18px;">Mechanisms</span>';
        html += '<span style="color:#444;font-weight:900;margin-left:10px;">(single-source and multi-source)</span>';
        html += "</div>";

        if (!mechs.length) {
            html += '<div style="padding:10px;color:#666;font-weight:900;">(No mechanisms on this page)</div>';
        }

        for (var m = 0; m < mechs.length; m++) {
            var mech = mechs[m];
            var active = mechanismIsActive(mech);
            var required = mechanismRequiredCount(mech);
            var pressed = countActiveMechanismSources(mech);
            var trap = mech.effects.primary || defaultPrimaryEffectConfig();
            var trapEnabled = trap.enabled && trap.type !== "none";
            var overrideActive = mech.kind === "group" && hasMechanismEditOverride(mech.legacyId);
            var editBlocked = mech.kind === "group" && mech.locks.configLocked && !overrideActive;
            var lockText = mech.locks.mechanismLocked ? (mech.locks.freezeWhenLocked ? "FROZEN" : "LOCKED") : "UNLOCKED";

            var name = mechanismDisplayName(mech);
            html += '<div style="border-top:2px solid #111;">';
            html += '<div style="padding:8px 10px;border-bottom:2px solid #111;">';
            html += '<span style="font-weight:900;font-size:18px;">' + esc(name) + "</span>" +
                badge(active ? "ACTIVE" : "INACTIVE", active);
            html += badge(mech.kind === "single" ? "SINGLE" : "MULTI", false);
            if (trapEnabled) html += badge("EFFECT", false);
            if (mech.kind === "group" && mech.locks.mechanismLocked) html += badge(lockText, false);
            if (mech.kind === "group" && mech.locks.configLocked) html += badge("CONFIG", false);
            if (overrideActive) html += badge("OVERRIDE", true);
            if (mech.kind === "group" && mech.locks.autoLock) html += badge("AUTOLOCK", true);
            html += "</div>";

            html += '<div style="padding:8px 10px;">';
            html += iconBtn("🛠️", "!mech edit " + mech.legacyId, "Edit mechanism");
            if (mech.kind === "single") {
                html += iconBtn("🔍", "!mech ping " + mech.legacyId, "Ping trigger");
                html += iconBtn("✅", "!mech checkplate " + mech.legacyId, "Check mechanism");
            } else {
                html += iconBtn("✅", "!mech groupcheck " + mech.legacyId, "Check mechanism");
            }

            html += '<div style="margin-top:6px;font-weight:900;">rule: <span style="font-weight:900;color:#333;">' + esc(mechanismRuleSummary(mech)) + "</span></div>";
            html += '<div style="margin-top:6px;font-weight:900;">effects: <span style="font-weight:900;color:#333;">' + esc(mechanismEffectSummary(mech)) + "</span></div>";
            html += '<div style="margin-top:6px;font-weight:900;">sources: <span style="font-weight:900;color:#333;">' + esc(String(mech.sources.length)) + "</span></div>";
            if (mech.kind === "single") {
                html += '<div style="margin-top:6px;font-weight:900;">trigger: <span style="font-weight:900;color:#333;">' + esc(sourceKindLabel(mech.sourceKind)) + "</span></div>";
            }

            if (mech.kind === "group") {
                html += '<div style="margin-top:6px;font-weight:900;">status: <span style="font-weight:900;color:#333;">' + esc(String(pressed)) + "/" + esc(String(required)) + " pressed</span></div>";
                html += '<div style="margin-top:6px;font-weight:900;">locks: <span style="font-weight:900;color:#333;">' + esc(lockText) + (mech.locks.configLocked ? ", CONFIG" : "") + (mech.locks.autoLock ? ", AUTOLOCK" : "") + "</span></div>";
            }

            if (String(mech.messages.on || "").trim()) {
                html += '<div style="margin-top:6px;color:#111;font-weight:900;">On: <span style="font-weight:700;">' + esc(mech.messages.on) + "</span></div>";
            }
            if (String(mech.messages.off || "").trim()) {
                html += '<div style="margin-top:4px;color:#111;font-weight:900;">Off: <span style="font-weight:700;">' + esc(mech.messages.off) + "</span></div>";
            }

            html += '<div style="margin-top:10px;font-weight:900;">Sources</div>';
            var anySourceListed = false;
            for (var s = 0; s < mech.sources.length; s++) {
                var srcId = mech.sources[s];
                var srcMech = getSingleMechanism(srcId);
                var src = getSourceObject(srcId, srcMech.sourceKind);
                if (!src || sourcePageId(src, srcMech.sourceKind) !== pageId) continue;
                anySourceListed = true;
                var srcState = sourceMechanismStateById(srcId);
                var srcName = sourceDisplayName(srcId, srcMech.sourceKind, src);
                html += '<div style="margin-left:12px;margin-top:6px;font-weight:900;">' +
                    esc(srcName) + ' <span style="color:#666;">(' + esc(sourceKindLabel(srcMech.sourceKind)) + ')</span>' +
                    badge(srcState.active ? "ACTIVE" : "INACTIVE", srcState.active) +
                    mini("Ping", "!mech ping " + srcId, "Ping this trigger");
                if (mech.kind === "group") {
                    if (editBlocked) html += miniDisabled("Remove", "Config locked");
                    else html += mini("Remove", "!mech groupdelplate " + mech.legacyId + " " + srcId, "Remove this trigger from the mechanism");
                }
                html += "</div>";
            }
            if (!anySourceListed) {
                html += '<div style="margin-left:12px;margin-top:6px;color:#666;font-weight:900;">(No sources on this page)</div>';
            }

            html += '<div style="margin-top:12px;font-weight:900;">Doors</div>';
            var hasDoors = false;
            for (var did3 in mech.effects.doors) {
                if (!mech.effects.doors.hasOwnProperty(did3)) continue;
                hasDoors = true;
                var d3 = getObj("door", did3);
                if (!d3) continue;

                html += "<div style=\"margin-left:12px;margin-top:6px;font-weight:900;\">" +
                    esc(String(mech.effects.doors[did3]).toUpperCase()) + " door …" + esc(shortId(did3)) +
                    " <span style=\"color:#666;\">(" + esc(doorBits(d3)) + ")</span> ";

                if (mech.kind === "group") {
                    if (editBlocked) html += miniDisabled("Detach", "Config locked");
                    else html += mini("Detach", "!mech groupdeldor " + mech.legacyId + " " + did3, "Detach this door from group");
                }

                html += "</div>";
            }
            if (!hasDoors) {
                html += '<div style="margin-left:12px;margin-top:6px;color:#666;font-weight:900;">(No doors bound)</div>';
            }

            html += "</div></div>";
        }

        html += "</div>";
        html += "</div></div>"; // body + shell

        whisper(html);
    }

    function showCommandHelp() {
        whisper(
            "Commands:<br>" +
            "<code>!mech ui</code>, <code>!mech edit REF</code>, <code>!mech setpage</code>, <code>!mech make NAME [pressurePlate|tripwire|proximity|manual|lever|button|doorState]</code>, <code>!mech add lock|secret</code>, <code>!mech check</code>, <code>!mech ping SOURCEID</code><br>" +
            "Single-Source Triggers:<br><code>!mech sourcetype SOURCEID pressurePlate|tripwire|proximity|manual|lever|button|doorState</code>, <code>!mech proximityrange SOURCEID CELLS</code>, <code>!mech doorstatemode SOURCEID open|closed|locked|unlocked|revealed|hidden</code><br>" +
            "<code>!mech manualon SOURCEID</code>, <code>!mech manualoff SOURCEID</code>, <code>!mech manualtoggle SOURCEID</code>, <code>!mech leveron SOURCEID</code>, <code>!mech leveroff SOURCEID</code>, <code>!mech levertoggle SOURCEID</code>, <code>!mech buttonpress SOURCEID</code>, <code>!mech buttonrelease SOURCEID</code>, <code>!mech buttontoggle SOURCEID</code><br>" +
            "Rule Controls:<br><code>!mech ruledelay REF SECONDS</code>, <code>!mech rulecooldown REF SECONDS</code>, <code>!mech ruleoneshot REF on|off</code>, <code>!mech reset REF</code><br>" +
            "Single-Source Effects:<br><code>!mech effectui SOURCEID</code> (alias for edit), <code>!mech effecttoggle SOURCEID</code>, <code>!mech effecttype SOURCEID alarm|damage|projectile|teleport|pit|reveal|save|status|spawn|none</code><br>" +
            "<code>!mech effecttrigger SOURCEID press|release|both</code>, <code>!mech effectmsg SOURCEID ...</code>, <code>!mech effectdamage SOURCEID XdY</code>, <code>!mech effectprojectilename SOURCEID ...</code>, <code>!mech effectprojectiledmgtype SOURCEID TYPE</code><br>" +
            "<code>!mech effectsavelabel SOURCEID LABEL</code>, <code>!mech effectsavedc SOURCEID DC</code>, <code>!mech effectsavesuccessmsg SOURCEID ...</code>, <code>!mech effectsavefailmsg SOURCEID ...</code><br>" +
            "<code>!mech effectsavesuccess SOURCEID half|none</code>, <code>!mech effectsavedmgtype SOURCEID TYPE</code>, <code>!mech effectsavefaildmg SOURCEID XdY</code>, <code>!mech effectstatusmarkers SOURCEID marker1,marker2</code>, <code>!mech effectstatusclear SOURCEID</code><br>" +
            "<code>!mech effectsetteleport SOURCEID</code>, <code>!mech effectclearteleport SOURCEID</code>, <code>!mech effectsetpit SOURCEID</code>, <code>!mech effectclearpit SOURCEID</code>, <code>!mech effectpitdamage SOURCEID XdY</code>, <code>!mech effectpitdmgtype SOURCEID TYPE</code><br>" +
            "<code>!mech effectsetreveal SOURCEID</code>, <code>!mech effectclearreveal SOURCEID</code>, <code>!mech effectrevealtoggle SOURCEID</code><br>" +
            "<code>!mech effectsetspawn SOURCEID</code>, <code>!mech effectclearspawn SOURCEID</code>, <code>!mech effectlocktoggle SOURCEID</code>, <code>!mech effectlockmarker SOURCEID MARKER</code>, <code>!mech effectunlock SOURCEID</code><br>" +
            "Messages:<br><code>!mech platemsgon SOURCEID ...</code>, <code>!mech platemsgoff SOURCEID ...</code><br>" +
            "Multi-Source Mechanisms:<br>" +
            "<code>!mech grouplock NAME</code> (mechanism lock), <code>!mech groupcfglock NAME</code> (config lock), <code>!mech groupoverride NAME</code> (60s override)<br>" +
            "<code>!mech groupautolock NAME</code>, <code>!mech groupreset NAME</code><br>" +
            "<code>!mech groupmake NAME [K]</code>, <code>!mech groupaddplates NAME</code>, <code>!mech groupadddoors NAME lock|secret</code><br>" +
            "<code>!mech groupmsgon NAME ...</code>, <code>!mech groupmsgoff NAME ...</code><br>" +
            "<code>!mech groupdelplate NAME SOURCEID</code>, <code>!mech groupdeldor NAME DOORID</code>, <code>!mech groupremove NAME</code>"
        );
    }

    function handleUiCommands(msg, sub) {
        if (sub === "ui") {
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "edit") {
            renderMechanismEditor(msg.playerid, msg.content.split(/\s+/)[2]);
            return true;
        }
        if (sub === "setpage") {
            setUIPage(msg.playerid);
            renderUI(msg.playerid);
            return true;
        }
        return false;
    }

    function handleSingleCommands(msg, sub, a, b, restFrom) {
        if (sub === "make") {
            cmdMakePlateFromSelected(msg, a, b);
            return true;
        }
        if (sub === "add") {
            cmdAddSingle(msg, a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "check") {
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "checkplate") {
            if (a) evaluateSingleMechanism(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "simopen") {
            if (a) cmdSimOpen(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "simclose") {
            if (a) cmdSimClose(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "removeplate") {
            if (a) cmdRemoveSingleMechanism(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "platemsgon") {
            if (a) cmdSetSingleMessageOn(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "platemsgoff") {
            if (a) cmdSetSingleMessageOff(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "ping") {
            if (a) cmdPingSource(msg.playerid, a);
            return true;
        }
        if (sub === "sourcetype") {
            if (a) cmdSetSingleSourceKind(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "doorstatemode") {
            if (a) cmdSetDoorStateMode(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "proximityrange") {
            if (a) cmdSetProximityRange(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "manualon") {
            if (a) cmdSetManualState(a, true);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "manualoff") {
            if (a) cmdSetManualState(a, false);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "manualtoggle") {
            if (a) cmdToggleManualState(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "leveron") {
            if (a) cmdSetLeverState(a, true);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "leveroff") {
            if (a) cmdSetLeverState(a, false);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "levertoggle") {
            if (a) cmdToggleLeverState(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "buttonpress") {
            if (a) cmdSetButtonState(a, true);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "buttonrelease") {
            if (a) cmdSetButtonState(a, false);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "buttontoggle") {
            if (a) cmdToggleButtonState(a);
            renderUI(msg.playerid);
            return true;
        }
        return false;
    }

    function handleRuleCommands(msg, sub, a, b) {
        if (sub === "ruledelay") {
            if (a) cmdSetMechanismDelay(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "rulecooldown") {
            if (a) cmdSetMechanismCooldown(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "ruleoneshot") {
            if (a) cmdSetMechanismOneShot(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "reset") {
            if (a) cmdResetMechanismRuntime(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        return false;
    }

    function handleEffectCommands(msg, sub, a, b, restFrom) {
        if (sub === "effectui") {
            if (a) renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effecttoggle") {
            if (a) cmdEffectToggle(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effecttype") {
            if (a) cmdEffectType(a, b);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effecttrigger") {
            if (a) cmdEffectTrigger(a, b);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectmsg") {
            if (a) cmdEffectMessage(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectdamage") {
            if (a) cmdEffectDamage(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectprojectilename") {
            if (a) cmdEffectProjectileLabel(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectprojectiledmgtype") {
            if (a) cmdEffectProjectileDamageType(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavelabel") {
            if (a) cmdEffectSaveLabel(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavedc") {
            if (a) cmdEffectSaveDc(a, b);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavesuccessmsg") {
            if (a) cmdEffectSaveSuccessMsg(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavefailmsg") {
            if (a) cmdEffectSaveFailMsg(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavesuccess") {
            if (a) cmdEffectSaveSuccessMode(a, b);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavedmgtype") {
            if (a) cmdEffectSaveDamageType(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsavefaildmg") {
            if (a) cmdEffectSaveFailDamage(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectstatusmarkers") {
            if (a) cmdEffectStatusMarkers(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectstatusclear") {
            if (a) cmdEffectStatusClearToggle(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsetteleport") {
            if (a) cmdEffectSetTeleport(msg, a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectclearteleport") {
            if (a) cmdEffectClearTeleport(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsetpit") {
            if (a) cmdEffectSetPitDestination(msg, a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectclearpit") {
            if (a) cmdEffectClearPitDestination(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectpitdamage") {
            if (a) cmdEffectPitDamage(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectpitdmgtype") {
            if (a) cmdEffectPitDamageType(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsetreveal") {
            if (a) cmdEffectSetReveal(msg, a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectclearreveal") {
            if (a) cmdEffectClearReveal(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectrevealtoggle") {
            if (a) cmdEffectRevealToggle(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectsetspawn") {
            if (a) cmdEffectSetSpawn(msg, a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectclearspawn") {
            if (a) cmdEffectClearSpawn(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectlocktoggle") {
            if (a) cmdEffectLockToggle(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectlockmarker") {
            if (a) cmdEffectLockMarker(a, restFrom(3));
            renderEffectUI(msg.playerid, a);
            return true;
        }
        if (sub === "effectunlock") {
            if (a) cmdEffectUnlock(a);
            renderEffectUI(msg.playerid, a);
            return true;
        }
        return false;
    }

    function handleGroupCommands(msg, sub, a, b, restFrom) {
        if (sub === "groupmake") {
            cmdCreateMultiMechanismFromSelected(msg, a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupaddplates") {
            cmdAddSourcesToMultiMechanism(msg, a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupadddoors") {
            cmdAddDoorsToMultiMechanism(msg, a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupsetall") {
            cmdSetMultiMechanismRequireAll(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupsetk") {
            cmdSetMultiMechanismRequiredCount(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "grouplock") {
            cmdToggleMechanismLock(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupcfglock") {
            cmdToggleMechanismConfigLock(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupoverride") {
            cmdEnableMechanismOverride(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupautolock") {
            cmdToggleMechanismAutoLock(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupreset") {
            cmdResetMechanismTriggerState(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupremove") {
            cmdRemoveMultiMechanism(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupcheck") {
            evaluateMultiSourceMechanism(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupdelplate") {
            cmdRemoveSourceFromMultiMechanism(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupdeldor") {
            cmdRemoveDoorFromMultiMechanism(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupmsgon") {
            if (a) cmdSetMultiMechanismMessageOn(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupmsgoff") {
            if (a) cmdSetMultiMechanismMessageOff(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        return false;
    }

    /* ---------- events ---------- */
    on("change:graphic", function (obj, prev) {
        if (obj.get("layer") !== "objects") return;
        if (obj.get("_subtype") !== "token") return;

        if (MOVE_LOCK_REENTRY[obj.id]) {
            delete MOVE_LOCK_REENTRY[obj.id];
            return;
        }

        var st = ensureState();
        var lock = st.lockedTokens[obj.id];
        if (lock) {
            var moved = (
                obj.get("left") !== lock.left ||
                obj.get("top") !== lock.top ||
                obj.get("_pageid") !== lock.pageId
            );

            if (moved) {
                MOVE_LOCK_REENTRY[obj.id] = true;
                obj.set({ left: lock.left, top: lock.top, _pageid: lock.pageId, layer: "objects" });
                return;
            }
        }

        if (
            obj.get("left") !== prev.left ||
            obj.get("top") !== prev.top ||
            obj.get("width") !== prev.width ||
            obj.get("height") !== prev.height ||
            obj.get("_pageid") !== prev._pageid
        ) {
            debouncedCheck();
        }
    });

    on("change:door", function (obj, prev) {
        if (
            obj.get("isOpen") !== prev.isOpen ||
            obj.get("isLocked") !== prev.isLocked ||
            obj.get("isSecret") !== prev.isSecret ||
            obj.get("x") !== prev.x ||
            obj.get("y") !== prev.y ||
            obj.get("left") !== prev.left ||
            obj.get("top") !== prev.top ||
            (obj.get("_pageid") || obj.get("pageid")) !== (prev._pageid || prev.pageid)
        ) {
            debouncedCheck();
        }
    });

    on("destroy:door", function () {
        debouncedCheck();
    });

    on("chat:message", function (msg) {
        if (msg.type !== "api") return;
        if (!playerIsGM(msg.playerid)) return;

        var parts = msg.content.split(/\s+/);
        if (parts[0] !== "!mech") return;

        var sub = (parts[1] || "").toLowerCase();
        var a = parts[2];
        var b = parts[3];

        // helper to capture the rest of the message (allows spaces)
        function restFrom(n) {
            return msg.content.split(/\s+/).slice(n).join(" ");
        }

        if (handleUiCommands(msg, sub)) return;
        if (handleSingleCommands(msg, sub, a, b, restFrom)) return;
        if (handleRuleCommands(msg, sub, a, b)) return;
        if (handleEffectCommands(msg, sub, a, b, restFrom)) return;
        if (handleGroupCommands(msg, sub, a, b, restFrom)) return;

        showCommandHelp();
    });

    on("ready", function () {
        ensureState();
        evaluateAll();
        sendChat("", "/w gm Loaded ✅  UI: !mech ui   (State key: " + STATE + ")");
    });

    return {};
})();
