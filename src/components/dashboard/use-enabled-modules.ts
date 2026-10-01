"use client";

import { useEffect, useState } from "react";
import { parseEnabledModules } from "@/lib/modules";

// One fetch per page load, shared by the sidebar and the mobile nav.
let cached: Set<string> | null | undefined;
let inflight: Promise<Set<string> | null> | null = null;

async function load(): Promise<Set<string> | null> {
    if (cached !== undefined) return cached;
    if (!inflight) {
        inflight = fetch("/api/settings/system")
            .then(r => (r.ok ? r.json() : null))
            .then(d => { cached = parseEnabledModules(d?.data?.enabledModules); return cached; })
            .catch(() => { cached = null; return null; })
            .finally(() => { inflight = null; });
    }
    return inflight;
}

/** Invalidate after the superadmin saves the module setting. */
export function resetEnabledModulesCache() {
    cached = undefined;
}

/** `undefined` while loading, `null` = all modules, otherwise the enabled set. */
export function useEnabledModules(): Set<string> | null | undefined {
    const [value, setValue] = useState<Set<string> | null | undefined>(cached);
    useEffect(() => {
        let alive = true;
        load().then(v => { if (alive) setValue(v); });
        const onUpdate = () => { resetEnabledModulesCache(); load().then(v => { if (alive) setValue(v); }); };
        window.addEventListener("system-settings-updated", onUpdate);
        return () => { alive = false; window.removeEventListener("system-settings-updated", onUpdate); };
    }, []);
    return value;
}
