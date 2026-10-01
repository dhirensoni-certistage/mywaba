"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isModuleEnabled, moduleForPath, parseEnabledModules } from "@/lib/modules";

/**
 * Blocks pages whose module the superadmin turned off (the sidebar already hides them,
 * this covers direct URLs and old bookmarks). Superadmins pass through.
 */
export function ModuleGate({ role, enabledModules, children }: { role?: string; enabledModules: unknown; children: React.ReactNode }) {
    const pathname = usePathname();
    const enabled = parseEnabledModules(enabledModules);
    const mod = moduleForPath(pathname);
    if (!mod || isModuleEnabled(mod.href, role, enabled)) return <>{children}</>;

    // Staff reaching an owner-only page (e.g. Sessions / QR from a "reconnect" link): this is a role
    // limit, not a switched-off module — say so, and say what to do instead.
    const ownerOnlyForStaff = role === "STAFF" && (mod.ownerOnly || mod.superadminOnly);

    return (
        <div className="flex h-full flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="rounded-full bg-muted p-5"><Lock className="h-10 w-10 text-muted-foreground" /></div>
            <h2 className="text-xl font-bold">{ownerOnlyForStaff ? `${mod.label} is for the account owner` : `${mod.label} is not enabled`}</h2>
            <p className="text-sm text-muted-foreground max-w-md">
                {ownerOnlyForStaff
                    ? mod.href === "/dashboard/sessions"
                        ? "Connecting, restarting or logging out a WhatsApp number is done by the account owner. If your number shows as disconnected, ask the owner to reconnect it from Sessions / QR — you will be able to chat and broadcast again as soon as it is back online."
                        : "This page changes settings that only the account owner can manage. Ask the owner if something here needs to change."
                    : "This module is switched off for your workspace. Ask your administrator if you need it."}
            </p>
            <Link href="/dashboard"><Button variant="outline">Back to Dashboard</Button></Link>
        </div>
    );
}
