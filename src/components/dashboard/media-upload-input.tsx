"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, X, Loader2, Image as ImageIcon, Video, Music, FileText, CheckCircle2, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";

interface MediaUploadInputProps {
    value: string;
    mediaType?: string;
    onChange: (url: string, mediaType?: string) => void;
    label?: string;
    helperText?: string;
}

export function MediaUploadInput({
    value,
    mediaType,
    onChange,
    label = "Media Attachment",
    helperText = "Upload an image, video, audio, or document (or enter a URL)"
}: MediaUploadInputProps) {
    const [uploading, setUploading] = useState(false);
    const [showUrlInput, setShowUrlInput] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        try {
            const formData = new FormData();
            formData.append("file", file);

            const res = await fetch("/api/upload", {
                method: "POST",
                body: formData,
            });

            const data = await res.json();
            if (res.ok && data.status) {
                onChange(data.data.url, data.data.mediaType);
                toast.success(`File "${file.name}" uploaded successfully!`);
            } else {
                toast.error(data.message || "Failed to upload file");
            }
        } catch (error: any) {
            console.error("Upload error:", error);
            toast.error("Error uploading file. Please try again.");
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handleClear = () => {
        onChange("", undefined);
    };

    const isImage = mediaType === "image" || /\.(jpg|jpeg|png|webp|gif)$/i.test(value);
    const isVideo = mediaType === "video" || /\.(mp4|mov|avi|webm)$/i.test(value);
    const isAudio = mediaType === "audio" || /\.(mp3|wav|ogg|opus)$/i.test(value);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">{label}</Label>
                <button
                    type="button"
                    onClick={() => setShowUrlInput(!showUrlInput)}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                    <LinkIcon className="h-3 w-3" />
                    {showUrlInput ? "Hide URL input" : "Enter URL manually"}
                </button>
            </div>

            {/* Hidden native file input */}
            <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.txt"
                onChange={handleFileSelect}
            />

            {/* If a file or URL is already selected */}
            {value ? (
                <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                    <div className="flex items-center gap-3 overflow-hidden">
                        <div className="h-10 w-10 shrink-0 rounded-md bg-primary/10 flex items-center justify-center text-primary overflow-hidden">
                            {isImage ? (
                                <img
                                    src={value}
                                    alt="Preview"
                                    className="h-full w-full object-cover"
                                    onError={(e) => {
                                        // If preview fails, fallback to icon
                                        (e.target as HTMLElement).style.display = "none";
                                    }}
                                />
                            ) : isVideo ? (
                                <Video className="h-5 w-5" />
                            ) : isAudio ? (
                                <Music className="h-5 w-5" />
                            ) : (
                                <FileText className="h-5 w-5" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-foreground truncate">
                                {value.split("/").pop() || "Attached Media"}
                            </p>
                            <p className="text-[11px] text-muted-foreground capitalize">
                                {mediaType || "Media"} attached
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="text-xs h-8"
                        >
                            Change
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handleClear}
                            className="text-xs h-8 text-destructive hover:bg-destructive/10"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            ) : (
                /* Upload Button */
                <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex-1 justify-center gap-2 border-dashed border-2 h-12 hover:bg-primary/5 hover:border-primary transition-colors"
                    >
                        {uploading ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                <span>Uploading file...</span>
                            </>
                        ) : (
                            <>
                                <Upload className="h-4 w-4 text-primary" />
                                <span className="font-medium">Upload File from Computer</span>
                            </>
                        )}
                    </Button>
                </div>
            )}

            {/* Optional URL input toggle */}
            {showUrlInput && (
                <div className="pt-1">
                    <Input
                        type="url"
                        placeholder="https://example.com/image.jpg"
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        className="text-xs"
                    />
                </div>
            )}

            {helperText && !value && (
                <p className="text-[11px] text-muted-foreground">{helperText}</p>
            )}
        </div>
    );
}
