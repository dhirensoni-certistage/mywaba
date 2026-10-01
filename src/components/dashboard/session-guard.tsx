"use client";

import { useSession } from "./session-provider";
import { useSession as useAuthSession } from "next-auth/react";
import { Bot, QrCode } from "lucide-react";
import { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function SessionGuard({ children }: { children: ReactNode }) {
    const { sessionId, loading, sessions } = useSession();
    const { data: authSession } = useAuthSession();
    const isStaff = (authSession?.user as { role?: string } | undefined)?.role === "STAFF";

    if (loading) {
        return <div className="flex h-full items-center justify-center p-8">Loading session...</div>;
    }

    if (!sessionId) {
        return (
            <div className="flex h-full flex-col items-center justify-center space-y-6 text-center p-8">
                <div className="rounded-full bg-green-100 p-6">
                    <QrCode className="h-12 w-12 text-green-600" />
                </div>
                <div className="space-y-2 max-w-md">
                    <h2 className="text-2xl font-bold tracking-tight">No Active Session</h2>
                    <p className="text-gray-500">
                        Please select a WhatsApp session from the top navigation bar to access this feature.
                    </p>
                </div>

                {sessions.length === 0 && (
                    isStaff ? (
                        <p className="text-sm text-gray-500 max-w-md">No WhatsApp number has been shared with your account yet. Ask the account owner to grant you access (Session Access).</p>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <p className="text-sm text-gray-500">You don&apos;t have any sessions yet.</p>
                            <Link href="/dashboard/sessions">
                                <Button variant="outline">Create a Session</Button>
                            </Link>
                        </div>
                    )
                )}
            </div>
        );
    }

    return <>{children}</>;
}
