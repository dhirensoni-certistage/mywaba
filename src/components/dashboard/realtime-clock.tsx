"use client";

import { useEffect, useState } from "react";
import moment from "moment-timezone";
import { Clock } from "lucide-react";

export function RealtimeClock() {
    const [time, setTime] = useState("");
    const [timezone, setTimezone] = useState("Asia/Kolkata");
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        // Fetch global timezone
        fetch('/api/settings/system')
            .then(r => r.json())
            .then(data => {
                if (data && data.data && data.data.timezone) {
                    setTimezone(data.data.timezone);
                }
            })
            .catch(() => { });

        const handleSettingsUpdate = (e: any) => {
            if (e.detail?.timezone) {
                setTimezone(e.detail.timezone);
            }
        };

        window.addEventListener("system-settings-updated", handleSettingsUpdate);
        return () => window.removeEventListener("system-settings-updated", handleSettingsUpdate);
    }, []);

    useEffect(() => {
        if (!mounted) return;

        const updateTime = () => {
            setTime(moment().tz(timezone).format("hh:mm:ss A"));
        };

        updateTime();
        const interval = setInterval(updateTime, 1000);
        return () => clearInterval(interval);
    }, [timezone, mounted]);

    if (!mounted) return null;

    return (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-md border border-slate-200 text-sm font-medium text-slate-700">
            <Clock className="h-4 w-4 text-slate-500" />
            <span>{time}</span>
            <span className="text-xs text-slate-400 border-l border-slate-300 pl-2 ml-1">{timezone}</span>
        </div>
    );
}
