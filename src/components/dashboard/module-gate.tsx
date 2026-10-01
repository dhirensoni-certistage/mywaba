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

    return (
        <div className="flex h-full flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="rounded-full bg-muted p-5"><Lock className="h-10 w-10 text-muted-foreground" /></div>
            <h2 className="text-xl font-bold">{mod.label} is not enabled</h2>
            <p className="text-sm text-muted-foreground max-w-md">
                This module is switched off for your workspace. Ask your administrator if you need it.
            </p>
            <Link href="/dashboard"><Button variant="outline">Back to Dashboard</Button></Link>
        </div>
    );
}
