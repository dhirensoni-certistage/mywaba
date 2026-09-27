import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

const MIME_MAP: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
};

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ filename: string }> }
) {
    try {
        const { filename } = await params;
        const safeName = path.basename(filename);
        const filePath = path.join(UPLOAD_DIR, safeName);

        if (!existsSync(filePath)) {
            return NextResponse.json({ status: false, message: "File not found" }, { status: 404 });
        }

        const fileStat = await stat(filePath);
        const ext = path.extname(safeName).toLowerCase();
        const contentType = MIME_MAP[ext] || "application/octet-stream";

        const fileBuffer = await readFile(filePath);

        return new NextResponse(fileBuffer, {
            status: 200,
            headers: {
                "Content-Type": contentType,
                "Content-Length": fileStat.size.toString(),
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        });
    } catch (e: any) {
        return NextResponse.json({ status: false, message: "Error serving file" }, { status: 500 });
    }
}
