import { NextResponse, NextRequest } from "next/server";
import si from "systeminformation";
import { getAuthenticatedUser } from "@/lib/api-auth";

// Ensure this route is dynamic
export const dynamic = "force-dynamic";

// systeminformation shells out to OS tools for several of these metrics. The dashboard polls
// every few seconds, so serve a short-lived cached snapshot instead of re-spawning processes
// for every request (and for every open browser tab).
const SNAPSHOT_TTL_MS = 2000;
let snapshot: { data: any; at: number } | null = null;
let inflight: Promise<any> | null = null;

async function collectMetrics() {
    const [cpu, mem, os, fsSize, networkStats] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.osInfo(),
        si.fsSize(),
        si.networkStats()
    ]);

    // Calculate Process (Node.js) Memory
    const processMemory = process.memoryUsage();

    return {
        cpu: {
            load: cpu.currentLoad,
            cores: cpu.cpus.map(c => c.load),
        },
        memory: {
            total: mem.total,
            used: mem.active,
            free: mem.available,
            swapTotal: mem.swaptotal,
            swapUsed: mem.swapused,
        },
        disk: fsSize.map(disk => ({
            fs: disk.fs,
            mount: disk.mount,
            size: disk.size,
            used: disk.used,
            usePercent: disk.use
        })),
        network: networkStats.map(net => ({
            iface: net.iface,
            rx_sec: net.rx_sec,
            tx_sec: net.tx_sec,
            state: net.operstate
        })).filter(net => net.state === "up" || net.rx_sec > 0 || net.tx_sec > 0),
        os: {
            platform: os.platform,
            distro: os.distro,
            release: os.release,
            uptime: si.time().uptime
        },
        process: {
            uptime: process.uptime(),
            heapTotal: processMemory.heapTotal,
            heapUsed: processMemory.heapUsed,
            rss: processMemory.rss,
        }
    };
}

async function getMetrics() {
    if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.data;
    if (!inflight) {
        inflight = collectMetrics()
            .then(data => { snapshot = { data, at: Date.now() }; return data; })
            .finally(() => { inflight = null; });
    }
    return inflight;
}

export async function GET(req: NextRequest) {
    try {
        const auth = await getAuthenticatedUser(req);
        if (!auth) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        // Global monitor needs SUPERADMIN
        if (auth.role !== "SUPERADMIN") {
            return NextResponse.json({ status: false, message: "Forbidden - Superadmin only" }, { status: 403 });
        }

        const data = await getMetrics();

        return NextResponse.json({
            status: true,
            message: "System metrics fetched successfully",
            data
        });

    } catch (error: any) {
        console.error("Monitor API Error:", error);
        return NextResponse.json({ status: false, message: error.message }, { status: 500 });
    }
}
