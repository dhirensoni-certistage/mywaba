import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getAuthenticatedUser } from "@/lib/api-auth";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

function getMediaType(mimeType: string, filename: string): "image" | "video" | "audio" | "document" {
    const ext = path.extname(filename).toLowerCase();
    if (mimeType.startsWith("image/") || [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
        return "image";
    }
    if (mimeType.startsWith("video/") || [".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) {
        return "video";
    }
    if (mimeType.startsWith("audio/") || [".mp3", ".wav", ".ogg", ".opus", ".m4a"].includes(ext)) {
        return "audio";
    }
    return "document";
}

export async function POST(request: NextRequest) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        const formData = await request.formData();
        const file = formData.get("file") as File;

        if (!file) {
            return NextResponse.json({ status: false, message: "No file provided" }, { status: 400 });
        }

        // Limit file size (50MB default)
        const maxMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB || "50", 10);
        if (file.size > maxMb * 1024 * 1024) {
            return NextResponse.json({ 
                status: false, 
                message: `File size exceeds the limit of ${maxMb}MB` 
            }, { status: 400 });
        }

        if (!existsSync(UPLOAD_DIR)) {
            await mkdir(UPLOAD_DIR, { recursive: true });
        }

        const timestamp = Date.now();
        const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
        const storedFilename = `${timestamp}-${cleanName}`;
        const filePath = path.join(UPLOAD_DIR, storedFilename);

        const bytes = await file.arrayBuffer();
        await writeFile(filePath, Buffer.from(bytes));

        const mediaType = getMediaType(file.type || "", file.name);
        const relativeUrl = `/api/upload/${storedFilename}`;

        // Build absolute URL for WhatsApp consumption
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
        const protocol = request.headers.get("x-forwarded-proto") || (process.env.NODE_ENV === "production" ? "https" : "http");
        const baseUrl = process.env.BASE_URL || (host ? `${protocol}://${host}` : "http://localhost:3030");
        const fullUrl = `${baseUrl.replace(/\/$/, "")}${relativeUrl}`;

        return NextResponse.json({
            status: true,
            message: "File uploaded successfully",
            data: {
                fileName: file.name,
                storedName: storedFilename,
                size: file.size,
                mimeType: file.type || "application/octet-stream",
                mediaType,
                url: fullUrl,
                relativeUrl,
            }
        });
    } catch (error: any) {
        console.error("Upload error:", error);
        return NextResponse.json({ status: false, message: error.message || "Failed to upload file" }, { status: 500 });
    }
}
