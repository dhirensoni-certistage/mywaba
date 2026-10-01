/**
 * Dashboard modules = sidebar entries. A SUPERADMIN decides which ones the workspace's users see
 * (Settings → Sidebar & Modules). Stored as SystemConfig.enabledModules (array of hrefs);
 * null means "everything". SUPERADMIN always sees everything.
 */
export interface ModuleDef {
    href: string;
    label: string;
    group: string;
    /** Only superadmins ever see this; it is not configurable. */
    superadminOnly?: boolean;
    /** Hidden for STAFF regardless of the module setting. */
    ownerOnly?: boolean;
    description?: string;
}

export const MODULES: ModuleDef[] = [
    { href: "/dashboard", label: "Dashboard", group: "Main", description: "Overview & session status" },
    { href: "/dashboard/sessions", label: "Sessions / QR", group: "Main", ownerOnly: true, description: "Connect WhatsApp numbers" },
    { href: "/dashboard/chat", label: "Chat", group: "Messaging", description: "Conversations & campaign replies" },
    { href: "/dashboard/broadcast", label: "Broadcast", group: "Messaging", description: "Bulk campaigns, scheduling, number health, safety guide" },
    { href: "/dashboard/templates", label: "Templates", group: "Messaging", description: "Saved messages for broadcasts" },
    { href: "/dashboard/lists", label: "Contact Lists", group: "Messaging", description: "Saved audiences for broadcasts and campaigns" },
    { href: "/dashboard/sticker", label: "Sticker Maker", group: "Messaging" },
    { href: "/dashboard/contacts", label: "Contacts", group: "Contacts", description: "Audience, names, opt-outs" },
    { href: "/dashboard/groups", label: "Groups", group: "Contacts" },
    { href: "/dashboard/labels", label: "Labels", group: "Contacts" },
    { href: "/dashboard/bot-settings", label: "Bot Settings", group: "Automation", ownerOnly: true, description: "Broadcast Safety, anti-spam, bot" },
    { href: "/dashboard/autoreply", label: "Auto Reply", group: "Automation", ownerOnly: true },
    { href: "/dashboard/profile", label: "Bot Profile", group: "Automation", ownerOnly: true },
    { href: "/dashboard/scheduler", label: "Scheduler", group: "Automation", description: "Scheduled messages" },
    { href: "/dashboard/webhooks", label: "Webhooks & API", group: "Automation", ownerOnly: true },
    { href: "/docs", label: "API Docs", group: "Developer" },
    { href: "/swagger", label: "Swagger UI", group: "Developer" },
    { href: "/dashboard/media", label: "Media Manager", group: "Administration" },
    { href: "/dashboard/sessions/access", label: "Session Access", group: "Administration", ownerOnly: true },
    { href: "/dashboard/users", label: "Users", group: "Administration", superadminOnly: true },
    { href: "/dashboard/settings", label: "Settings", group: "Administration", ownerOnly: true },
    { href: "/dashboard/system-monitor", label: "System Monitor", group: "Administration", superadminOnly: true },
    { href: "/dashboard/notifications", label: "Notifications", group: "Administration", superadminOnly: true },
];

/** Hrefs a superadmin can toggle (superadmin-only entries are never part of the setting). */
export const CONFIGURABLE_MODULES = MODULES.filter(m => !m.superadminOnly);

export const MODULE_PRESETS: Record<string, { label: string; description: string; hrefs: string[] }> = {
    essentials: {
        label: "Broadcast essentials",
        description: "What a marketing client needs: connect number, chat, broadcast, contacts, scheduler, safety settings.",
        hrefs: ["/dashboard", "/dashboard/sessions", "/dashboard/chat", "/dashboard/broadcast", "/dashboard/templates", "/dashboard/lists", "/dashboard/contacts", "/dashboard/scheduler", "/dashboard/bot-settings", "/dashboard/settings"],
    },
    support: {
        label: "Support desk",
        description: "Chat-first: conversations, contacts, labels, auto-reply, no broadcasting.",
        hrefs: ["/dashboard", "/dashboard/sessions", "/dashboard/chat", "/dashboard/contacts", "/dashboard/labels", "/dashboard/autoreply", "/dashboard/bot-settings", "/dashboard/settings"],
    },
    full: {
        label: "Everything",
        description: "All modules, including developer tools.",
        hrefs: CONFIGURABLE_MODULES.map(m => m.href),
    },
};

/** Normalize a stored value into a Set of hrefs, or null for "all". */
export function parseEnabledModules(value: unknown): Set<string> | null {
    if (!Array.isArray(value)) return null;
    const known = new Set(MODULES.map(m => m.href));
    const list = value.map(String).filter(h => known.has(h));
    return new Set(list);
}

/** Is the module at `href` visible for this role under this setting? */
export function isModuleEnabled(href: string, role: string | undefined, enabled: Set<string> | null): boolean {
    if (role === "SUPERADMIN") return true;
    // Longest matching module owns the path (/dashboard/sessions/access is its own module, not part of /dashboard/sessions)
    const def = moduleForPath(href);
    if (def?.superadminOnly) return false;
    if (def?.ownerOnly && role === "STAFF") return false;
    if (!enabled) return true;
    // Sub-routes inherit their parent module (e.g. /dashboard/sessions/abc → /dashboard/sessions)
    const key = def?.href ?? href;
    return enabled.has(key);
}

/** Resolve the module that owns a pathname (longest matching href), for the page gate. */
export function moduleForPath(pathname: string): ModuleDef | undefined {
    const candidates = MODULES.filter(m => pathname === m.href || (m.href !== "/dashboard" && pathname.startsWith(m.href + "/")));
    candidates.sort((a, b) => b.href.length - a.href.length);
    return candidates[0] ?? (pathname === "/dashboard" ? MODULES[0] : undefined);
}
