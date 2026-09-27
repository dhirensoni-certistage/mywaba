"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";

interface RegistrationWarningProps {
    role?: string;
    registrationEnabled?: boolean;
}

export function RegistrationWarning({ role, registrationEnabled }: RegistrationWarningProps) {
    useEffect(() => {
        // Only run for SUPERADMIN when registration is enabled
        if (role === "SUPERADMIN" && registrationEnabled) {
            // Check if user has already seen or dismissed this warning in the current browser session
            if (typeof window !== "undefined" && sessionStorage.getItem("waba_reg_warning_dismissed")) {
                return;
            }

            // Delay toast slightly to wait for `<Toaster>` provider mount in layout
            const timer = setTimeout(() => {
                // Mark as shown so it doesn't fire on every page refresh
                sessionStorage.setItem("waba_reg_warning_dismissed", "true");

                toast("Public Registration is Enabled", {
                    description: "Anyone can register to this instance. If this is unintended, disable it in System Settings to prevent unauthorized access.",
                    icon: <ShieldAlert className="text-amber-500 w-5 h-5" />,
                    duration: 6000,
                    position: "top-center",
                    action: {
                        label: "Settings",
                        onClick: () => {
                            window.location.href = "/dashboard/settings";
                        }
                    }
                });
            }, 1000);

            return () => clearTimeout(timer);
        }
    }, [role, registrationEnabled]);

    return null;
}
