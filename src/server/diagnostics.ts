/**
 * Production diagnostics that need no SSH tunnel and no restart.
 *
 * `kill -USR2 <pid>` (or `pm2 sendSignal SIGUSR2 waba`) records a CPU profile of the main thread for
 * CPU_PROFILE_SECONDS (default 30), writes it to logs/cpu-<timestamp>.cpuprofile (open it in Chrome
 * DevTools → Performance → Load profile) and prints the hottest functions to the log, so a "why is
 * this process at 95% CPU" question can be answered from `pm2 logs` alone.
 */
import { Session } from "node:inspector";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger";

type ProfileNode = {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
};
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };

let profiling = false;

function summarize(profile: Profile, top = 15): string[] {
    const byId = new Map<number, ProfileNode>();
    for (const n of profile.nodes) byId.set(n.id, n);
    const selfMicros = new Map<number, number>();
    profile.samples.forEach((id, i) => {
        selfMicros.set(id, (selfMicros.get(id) || 0) + (profile.timeDeltas[i] || 0));
    });
    const total = Math.max(1, profile.endTime - profile.startTime);
    return [...selfMicros.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([id, micros]) => {
            const n = byId.get(id);
            const name = n?.callFrame.functionName || "(anonymous)";
            const where = n?.callFrame.url ? `${n.callFrame.url.replace(/^file:\/\//, "")}:${n.callFrame.lineNumber + 1}` : "";
            return `${((micros / total) * 100).toFixed(1).padStart(5)}%  ${name}  ${where}`.trimEnd();
        });
}

export function installDiagnostics() {
    const seconds = Math.max(1, parseInt(process.env.CPU_PROFILE_SECONDS || "30", 10) || 30);

    process.on("SIGUSR2", () => {
        if (profiling) {
            logger.warn("Diag", "CPU profile already running");
            return;
        }
        profiling = true;
        const usageBefore = process.cpuUsage();
        const session = new Session();
        session.connect();
        session.post("Profiler.enable", () => {
            session.post("Profiler.start", () => {
                logger.info("Diag", `CPU profile started for ${seconds}s (SIGUSR2). Event-loop threads: ${process.report ? "see logs" : "n/a"}`);
                setTimeout(() => {
                    session.post("Profiler.stop", (err, result) => {
                        try {
                            if (err) throw err;
                            const profile = result.profile as unknown as Profile;
                            const dir = join(process.cwd(), "logs");
                            mkdirSync(dir, { recursive: true });
                            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                            const file = join(dir, `cpu-${stamp}.cpuprofile`);
                            writeFileSync(file, JSON.stringify(profile));
                            const usage = process.cpuUsage(usageBefore);
                            const busyPct = ((usage.user + usage.system) / 1000 / (seconds * 1000)) * 100;
                            const lines = summarize(profile);
                            writeFileSync(join(dir, `cpu-${stamp}.txt`), [`process CPU during profile: ${busyPct.toFixed(1)}% of one core`, ...lines].join("\n") + "\n");
                            logger.info("Diag", `CPU profile written to ${file}`);
                            logger.info("Diag", `Process CPU during the profile: ${busyPct.toFixed(1)}% of one core (main thread + workers). Hottest functions on the main thread (self time):\n  ${lines.join("\n  ")}`);
                            if (busyPct > 50 && lines.length && parseFloat(lines[0]) < 5) {
                                logger.warn("Diag", "Process is busy but the main thread is mostly idle: the load is in a worker/helper thread, not in application code.");
                            }
                        } catch (e) {
                            logger.error("Diag", "CPU profile failed", e);
                        } finally {
                            session.disconnect();
                            profiling = false;
                        }
                    });
                }, seconds * 1000).unref();
            });
        });
    });
}
