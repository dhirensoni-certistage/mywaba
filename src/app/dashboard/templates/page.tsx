"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/dashboard/session-provider";
import { useSession as useAuthSession } from "next-auth/react";
import { SessionGuard } from "@/components/dashboard/session-guard";
import { MediaUploadInput } from "@/components/dashboard/media-upload-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { FileText, Plus, Pencil, Trash2, RefreshCw, MousePointerClick, X, Megaphone } from "lucide-react";
import Link from "next/link";

interface TemplateButton { type: "reply" | "url" | "call"; text: string; url?: string; phone?: string }
interface Template {
    id: string; name: string; body: string; mediaUrl: string | null; mediaType: string | null;
    buttons: TemplateButton[] | null; footer: string | null; buttonMode: "interactive" | "text" | null; usageCount: number; updatedAt: string;
}
const emptyDraft = { name: "", body: "", mediaUrl: "", mediaType: "image", buttons: [] as TemplateButton[], footer: "", buttonMode: "interactive" as "interactive" | "text" };

export default function TemplatesPage() {
    const { sessionId } = useSession();
    const { data: authSession } = useAuthSession();
    const canEdit = (authSession?.user as { role?: string } | undefined)?.role !== "STAFF";
    const [templates, setTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<Template | null>(null);
    const [draft, setDraft] = useState(emptyDraft);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/templates?sessionId=${encodeURIComponent(sessionId || "")}`);
            const json = await res.json();
            setTemplates(json?.data || []);
        } catch { toast.error("Could not load templates"); }
        finally { setLoading(false); }
    }, [sessionId]);
    useEffect(() => { load(); }, [load]);

    const startNew = () => { setEditing(null); setDraft(emptyDraft); setOpen(true); };
    const startEdit = (t: Template) => {
        setEditing(t);
        setDraft({ name: t.name, body: t.body, mediaUrl: t.mediaUrl || "", mediaType: t.mediaType || "image", buttons: t.buttons || [], footer: t.footer || "", buttonMode: t.buttonMode || "interactive" });
        setOpen(true);
    };

    const save = async () => {
        if (!draft.name.trim()) return toast.error("Give the template a name");
        if (!draft.body.trim() && !draft.mediaUrl.trim()) return toast.error("Add a message or media");
        setSaving(true);
        try {
            const body = {
                name: draft.name.trim(), body: draft.body, mediaUrl: draft.mediaUrl.trim() || null, mediaType: draft.mediaUrl.trim() ? draft.mediaType : null,
                buttons: draft.buttons.filter(b => b.text.trim()).map(b => ({ type: b.type, text: b.text.trim(), url: b.url?.trim() || undefined, phone: b.phone?.trim() || undefined })),
                footer: draft.footer.trim() || null, buttonMode: draft.buttonMode
            };
            const res = await fetch(editing ? `/api/templates/${editing.id}` : "/api/templates", { method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const json = await res.json();
            if (!res.ok || !json.status) throw new Error(json.message || "Save failed");
            toast.success(json.message);
            setOpen(false);
            load();
        } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Save failed"); }
        finally { setSaving(false); }
    };

    const remove = async (t: Template) => {
        if (!confirm(`Delete template "${t.name}"?`)) return;
        const res = await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
        const json = await res.json();
        if (res.ok && json.status) { toast.success("Template deleted"); load(); } else toast.error(json.message || "Delete failed");
    };

    const updateButton = (i: number, patch: Partial<TemplateButton>) => setDraft(d => ({ ...d, buttons: d.buttons.map((b, idx) => idx === i ? { ...b, ...patch } : b) }));

    return (
        <SessionGuard>
            <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                        <h2 className="text-xl sm:text-3xl font-bold tracking-tight">Message Templates</h2>
                        <p className="text-muted-foreground text-sm mt-1">Save messages you send often. Pick them on the Broadcast page with one click. Placeholders: <code className="bg-muted px-1 rounded">{"{name}"}</code>, <code className="bg-muted px-1 rounded">{"{name|there}"}</code>, <code className="bg-muted px-1 rounded">{"{city}"}</code> (any Excel column), <code className="bg-muted px-1 rounded">{"{Hi|Hello}"}</code> (random choice).</p>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh</Button>
                        {canEdit && <Button size="sm" onClick={startNew}><Plus className="h-4 w-4 mr-1" /> New template</Button>}
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                ) : templates.length === 0 ? (
                    <Card className="border-dashed"><CardContent className="py-12 text-center text-muted-foreground">
                        <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">No templates yet.{canEdit ? " Create one here, or write a message on the Broadcast page and press “Save as template”." : " Ask the account owner to create some."}</p>
                    </CardContent></Card>
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {templates.map(t => (
                            <Card key={t.id} className="flex flex-col">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base flex items-center justify-between gap-2">
                                        <span className="truncate">{t.name}</span>
                                        <span className="text-[10px] font-normal text-muted-foreground shrink-0">used {t.usageCount}×</span>
                                    </CardTitle>
                                    <CardDescription className="text-[11px]">
                                        {t.mediaUrl ? `${t.mediaType || "media"} attached · ` : ""}{t.buttons?.length ? `${t.buttons.length} button(s) (${t.buttonMode || "interactive"}) · ` : ""}updated {new Date(t.updatedAt).toLocaleDateString()}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="flex-1 flex flex-col gap-3">
                                    <p className="text-sm whitespace-pre-wrap line-clamp-6 text-muted-foreground flex-1">{t.body || <em>(media only)</em>}</p>
                                    <div className="flex gap-2">
                                        <Link href={`/dashboard/broadcast?template=${t.id}`} className="flex-1"><Button variant="outline" size="sm" className="w-full"><Megaphone className="h-3.5 w-3.5 mr-1" /> Use</Button></Link>
                                        {canEdit && <Button variant="ghost" size="sm" onClick={() => startEdit(t)}><Pencil className="h-3.5 w-3.5" /></Button>}
                                        {canEdit && <Button variant="ghost" size="sm" className="text-red-500" onClick={() => remove(t)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}

                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle>{editing ? "Edit template" : "New template"}</DialogTitle>
                            <DialogDescription>Everything here is applied to the Broadcast form when the template is picked.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                            <div className="space-y-1.5"><Label>Name</Label><Input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="Diwali offer, Seminar reminder…" maxLength={80} /></div>
                            <div className="space-y-1.5">
                                <Label>Message</Label>
                                <Textarea className="min-h-[140px]" value={draft.body} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))} placeholder={"{Hi|Hello} {name|there}, …"} />
                            </div>
                            <MediaUploadInput value={draft.mediaUrl} mediaType={draft.mediaType} onChange={(url, type) => setDraft(d => ({ ...d, mediaUrl: url, mediaType: type || d.mediaType }))} label="Media (optional)" helperText="Image, video, audio or document" />
                            <div className="space-y-2 rounded-lg border border-dashed p-3">
                                <div className="flex items-center justify-between">
                                    <Label className="text-xs flex items-center gap-1.5"><MousePointerClick className="h-3.5 w-3.5" /> Buttons (optional, max 3)</Label>
                                    <Button type="button" variant="outline" size="sm" disabled={draft.buttons.length >= 3} onClick={() => setDraft(d => ({ ...d, buttons: [...d.buttons, { type: "reply", text: "" }] }))}><Plus className="h-3.5 w-3.5 mr-1" /> Add</Button>
                                </div>
                                {draft.buttons.map((b, i) => (
                                    <div key={i} className="grid grid-cols-[110px_1fr_auto] gap-2 items-center">
                                        <Select value={b.type} onValueChange={(v: string) => updateButton(i, { type: v as TemplateButton["type"] })}>
                                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                            <SelectContent><SelectItem value="reply">Quick reply</SelectItem><SelectItem value="url">Open link</SelectItem><SelectItem value="call">Call</SelectItem></SelectContent>
                                        </Select>
                                        <div className="flex gap-2">
                                            <Input className="h-8 text-xs" placeholder="Button text (max 25)" maxLength={25} value={b.text} onChange={e => updateButton(i, { text: e.target.value })} />
                                            {b.type === "url" && <Input className="h-8 text-xs" placeholder="https://…" value={b.url || ""} onChange={e => updateButton(i, { url: e.target.value })} />}
                                            {b.type === "call" && <Input className="h-8 text-xs" placeholder="+919876543210" value={b.phone || ""} onChange={e => updateButton(i, { phone: e.target.value })} />}
                                        </div>
                                        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setDraft(d => ({ ...d, buttons: d.buttons.filter((_, idx) => idx !== i) }))}><X className="h-3.5 w-3.5" /></Button>
                                    </div>
                                ))}
                                {draft.buttons.length > 0 && (
                                    <div className="grid sm:grid-cols-2 gap-2">
                                        <Input className="h-8 text-xs" placeholder="Footer line (optional, max 60)" maxLength={60} value={draft.footer} onChange={e => setDraft(d => ({ ...d, footer: e.target.value }))} />
                                        <Select value={draft.buttonMode} onValueChange={(v: string) => setDraft(d => ({ ...d, buttonMode: v === "text" ? "text" : "interactive" }))}>
                                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                            <SelectContent><SelectItem value="interactive">Interactive buttons (BETA)</SelectItem><SelectItem value="text">Text options (every phone)</SelectItem></SelectContent>
                                        </Select>
                                    </div>
                                )}
                            </div>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                            <Button onClick={save} disabled={saving}>{saving ? <RefreshCw className="h-4 w-4 animate-spin mr-1" /> : null}{editing ? "Save changes" : "Create template"}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </SessionGuard>
    );
}
