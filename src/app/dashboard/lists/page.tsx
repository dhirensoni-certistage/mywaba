"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/dashboard/session-provider";
import { useSession as useAuthSession } from "next-auth/react";
import { SessionGuard } from "@/components/dashboard/session-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ListChecks, Plus, Trash2, RefreshCw, Upload, Download, Search, Megaphone, ArrowLeft, UserMinus } from "lucide-react";
import Link from "next/link";

interface ListRow { id: string; name: string; description: string | null; members: number; campaigns: number; updatedAt: string }
interface Member { id: string; jid: string; number: string; name: string | null; vars: Record<string, string> | null; createdAt: string }

/** "919876543210, Dhiren" / "919876543210;Dhiren" / "919876543210 Dhiren" → recipient objects */
function parsePasted(text: string) {
    return text.split(/\n+/).map(l => l.trim()).filter(Boolean).map(line => {
        const m = line.match(/^\+?([0-9][0-9\s-]{6,})\s*(?:[,;|\t]\s*|\s+)?(.*)$/);
        if (!m) return { number: line };
        return { number: m[1].replace(/[\s-]/g, ""), name: m[2]?.trim() || undefined };
    });
}

export default function ContactListsPage() {
    const { sessionId } = useSession();
    const { data: authSession } = useAuthSession();
    const canEdit = (authSession?.user as { role?: string } | undefined)?.role !== "STAFF";
    const [lists, setLists] = useState<ListRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [createOpen, setCreateOpen] = useState(false);
    const [draft, setDraft] = useState({ name: "", description: "", paste: "" });
    const [saving, setSaving] = useState(false);

    // Selected list
    const [current, setCurrent] = useState<ListRow | null>(null);
    const [members, setMembers] = useState<Member[]>([]);
    const [total, setTotal] = useState(0);
    const [membersLoading, setMembersLoading] = useState(false);
    const [q, setQ] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [addText, setAddText] = useState("");
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/contact-lists?sessionId=${encodeURIComponent(sessionId || "")}`);
            const json = await res.json();
            setLists(json?.data || []);
        } catch { toast.error("Could not load lists"); }
        finally { setLoading(false); }
    }, [sessionId]);
    useEffect(() => { load(); }, [load]);

    const loadMembers = useCallback(async (list: ListRow, query = "") => {
        setMembersLoading(true);
        try {
            const res = await fetch(`/api/contact-lists/${list.id}?limit=5000${query ? `&q=${encodeURIComponent(query)}` : ""}`);
            const json = await res.json();
            setMembers(json?.data?.members || []);
            setTotal(json?.data?.allMembers ?? 0);
            setSelected(new Set());
        } catch { toast.error("Could not load members"); }
        finally { setMembersLoading(false); }
    }, []);

    const openList = (l: ListRow) => { setCurrent(l); setQ(""); setAddText(""); loadMembers(l); };
    useEffect(() => { if (!current) return; const t = setTimeout(() => loadMembers(current, q), 300); return () => clearTimeout(t); }, [q, current, loadMembers]);

    const createList = async () => {
        if (!draft.name.trim()) return toast.error("Give the list a name");
        setSaving(true);
        try {
            const res = await fetch("/api/contact-lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: draft.name.trim(), description: draft.description.trim() || null, recipients: draft.paste.trim() ? parsePasted(draft.paste) : [] }) });
            const json = await res.json();
            if (!res.ok || !json.status) throw new Error(json.message || "Create failed");
            toast.success(json.message);
            setCreateOpen(false); setDraft({ name: "", description: "", paste: "" });
            load();
        } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Create failed"); }
        finally { setSaving(false); }
    };

    const deleteList = async (l: ListRow) => {
        if (!confirm(`Delete list "${l.name}" with ${l.members} member(s)?`)) return;
        const res = await fetch(`/api/contact-lists/${l.id}`, { method: "DELETE" });
        const json = await res.json();
        if (res.ok && json.status) { toast.success("List deleted"); if (current?.id === l.id) setCurrent(null); load(); } else toast.error(json.message || "Delete failed");
    };

    const addMembers = async (recipients: unknown[]) => {
        if (!current || recipients.length === 0) return;
        setAdding(true);
        try {
            const res = await fetch(`/api/contact-lists/${current.id}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipients }) });
            const json = await res.json();
            if (!res.ok || !json.status) throw new Error(json.message || "Add failed");
            toast.success(json.message);
            setAddText("");
            await Promise.all([loadMembers(current, q), load()]);
        } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Add failed"); }
        finally { setAdding(false); }
    };

    const uploadFile = async (file: File | null) => {
        if (!file || !sessionId || !current) return;
        setAdding(true);
        try {
            const fd = new FormData(); fd.append("file", file);
            const res = await fetch(`/api/messages/${sessionId}/broadcast/recipients/parse`, { method: "POST", body: fd });
            const json = await res.json();
            if (!res.ok || !json.status) throw new Error(json.message || "Could not read the file");
            const rows = (json.data?.rows || []).map((r: { number: string; name: string | null; vars: Record<string, string> }) => ({ number: r.number, name: r.name, vars: r.vars }));
            if (rows.length === 0) throw new Error("No numbers found in the file");
            await addMembers(rows);
        } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Upload failed"); setAdding(false); }
    };

    const removeSelected = async () => {
        if (!current || selected.size === 0) return;
        if (!confirm(`Remove ${selected.size} member(s) from "${current.name}"?`)) return;
        const res = await fetch(`/api/contact-lists/${current.id}/members`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jids: Array.from(selected) }) });
        const json = await res.json();
        if (res.ok && json.status) { toast.success(json.message); await Promise.all([loadMembers(current, q), load()]); } else toast.error(json.message || "Remove failed");
    };

    const exportCsv = () => {
        if (!current) return;
        const cols = Array.from(new Set(members.flatMap(m => Object.keys(m.vars || {})))).filter(c => c !== "name");
        const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, "\"\"")}"`;
        const lines = [["phone", "name", ...cols].join(","), ...members.map(m => [m.number, m.name || "", ...cols.map(c => m.vars?.[c] ?? "")].map(esc).join(","))];
        const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${current.name.replace(/[^a-z0-9]+/gi, "-")}.csv`; a.click(); URL.revokeObjectURL(a.href);
    };

    const allSelected = useMemo(() => members.length > 0 && members.every(m => selected.has(m.jid)), [members, selected]);

    return (
        <SessionGuard>
            <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                        <h2 className="text-xl sm:text-3xl font-bold tracking-tight">Contact Lists</h2>
                        <p className="text-muted-foreground text-sm mt-1">Saved audiences for broadcasts: build them once from Excel or pasted numbers, reuse them on the Broadcast page and in scheduled campaigns. Opted-out numbers are skipped automatically at send time.</p>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh</Button>
                        {canEdit && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1" /> New list</Button>}
                    </div>
                </div>

                {!current ? (
                    loading ? (
                        <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                    ) : lists.length === 0 ? (
                        <Card className="border-dashed"><CardContent className="py-12 text-center text-muted-foreground">
                            <ListChecks className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p className="text-sm">No lists yet.{canEdit ? " Create one here, or upload numbers on the Broadcast page and press “Save as list”." : " Ask the account owner to create some."}</p>
                        </CardContent></Card>
                    ) : (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {lists.map(l => (
                                <Card key={l.id} className="cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => openList(l)}>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-base flex items-center justify-between gap-2"><span className="truncate">{l.name}</span><span className="text-xs font-normal text-muted-foreground shrink-0">{l.members} contacts</span></CardTitle>
                                        <CardDescription className="text-[11px]">{l.description || "—"}{l.campaigns > 0 ? ` · used by ${l.campaigns} campaign(s)` : ""} · updated {new Date(l.updatedAt).toLocaleDateString()}</CardDescription>
                                    </CardHeader>
                                    <CardContent className="flex gap-2" onClick={e => e.stopPropagation()}>
                                        <Link href={`/dashboard/broadcast?list=${l.id}`} className="flex-1"><Button variant="outline" size="sm" className="w-full"><Megaphone className="h-3.5 w-3.5 mr-1" /> Broadcast</Button></Link>
                                        <Button variant="outline" size="sm" onClick={() => openList(l)}>Open</Button>
                                        {canEdit && <Button variant="ghost" size="sm" className="text-red-500" onClick={() => deleteList(l)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )
                ) : (
                    <Card>
                        <CardHeader>
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                    <Button variant="ghost" size="sm" onClick={() => setCurrent(null)}><ArrowLeft className="h-4 w-4" /></Button>
                                    <div className="min-w-0">
                                        <CardTitle className="truncate">{current.name}</CardTitle>
                                        <CardDescription>{total} contact(s){current.description ? ` · ${current.description}` : ""}</CardDescription>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Link href={`/dashboard/broadcast?list=${current.id}`}><Button size="sm"><Megaphone className="h-3.5 w-3.5 mr-1" /> Broadcast to this list</Button></Link>
                                    <Button variant="outline" size="sm" onClick={exportCsv} disabled={members.length === 0}><Download className="h-3.5 w-3.5 mr-1" /> Export CSV</Button>
                                    {canEdit && <Button variant="outline" size="sm" className="text-red-500" onClick={removeSelected} disabled={selected.size === 0}><UserMinus className="h-3.5 w-3.5 mr-1" /> Remove {selected.size || ""}</Button>}
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {canEdit && (
                                <div className="grid md:grid-cols-2 gap-3 rounded-lg border border-dashed p-3">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Paste numbers (one per line, optional name after a comma)</Label>
                                        <Textarea className="min-h-[90px] font-mono text-xs" placeholder={"919876543210, Dhiren\n919876543211"} value={addText} onChange={e => setAddText(e.target.value)} disabled={adding} />
                                        <Button size="sm" onClick={() => addMembers(parsePasted(addText))} disabled={adding || !addText.trim()}>{adding ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />} Add to list</Button>
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" /> Upload Excel / CSV</Label>
                                        <Input type="file" accept=".xlsx,.xls,.csv,.txt" className="text-xs" disabled={adding} onChange={e => { uploadFile(e.target.files?.[0] || null); e.target.value = ""; }} />
                                        <p className="text-[11px] text-muted-foreground">Header row with a <code className="bg-muted px-1 rounded">phone</code> / <code className="bg-muted px-1 rounded">number</code> column; <code className="bg-muted px-1 rounded">name</code> and any other columns become placeholders. Duplicates are skipped, existing names are updated.</p>
                                    </div>
                                </div>
                            )}
                            <div className="relative">
                                <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
                                <Input className="pl-8" placeholder="Search number or name…" value={q} onChange={e => setQ(e.target.value)} />
                            </div>
                            {membersLoading ? (
                                <div className="flex items-center justify-center py-8"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                            ) : members.length === 0 ? (
                                <p className="text-sm text-muted-foreground text-center py-8">{q ? "No match." : "This list is empty."}</p>
                            ) : (
                                <div className="rounded-lg border overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted/50 text-xs text-muted-foreground">
                                            <tr>
                                                {canEdit && <th className="p-2 w-8"><Checkbox checked={allSelected} onCheckedChange={c => setSelected(c ? new Set(members.map(m => m.jid)) : new Set())} /></th>}
                                                <th className="text-left p-2">Number</th><th className="text-left p-2">Name</th><th className="text-left p-2">Other fields</th><th className="text-left p-2">Added</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {members.map(m => (
                                                <tr key={m.id} className="border-t">
                                                    {canEdit && <td className="p-2"><Checkbox checked={selected.has(m.jid)} onCheckedChange={c => setSelected(prev => { const n = new Set(prev); if (c) n.add(m.jid); else n.delete(m.jid); return n; })} /></td>}
                                                    <td className="p-2 font-mono text-xs">{m.number}</td>
                                                    <td className="p-2">{m.name || <span className="text-muted-foreground">—</span>}</td>
                                                    <td className="p-2 text-xs text-muted-foreground truncate max-w-[280px]">{m.vars ? Object.entries(m.vars).filter(([k]) => k !== "name").map(([k, v]) => `${k}: ${v}`).join(" · ") : ""}</td>
                                                    <td className="p-2 text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleDateString()}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {total > members.length && !q && <p className="text-[11px] text-muted-foreground p-2">Showing the first {members.length} of {total}. Use search to find others.</p>}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>New contact list</DialogTitle>
                            <DialogDescription>You can add numbers now or later (paste or Excel upload).</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                            <div className="space-y-1.5"><Label>Name</Label><Input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="Seminar 2026 attendees" maxLength={80} /></div>
                            <div className="space-y-1.5"><Label>Description (optional)</Label><Input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} maxLength={300} /></div>
                            <div className="space-y-1.5"><Label>Numbers (optional, one per line, name after a comma)</Label><Textarea className="min-h-[100px] font-mono text-xs" placeholder={"919876543210, Dhiren\n919876543211"} value={draft.paste} onChange={e => setDraft(d => ({ ...d, paste: e.target.value }))} /></div>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                            <Button onClick={createList} disabled={saving}>{saving ? <RefreshCw className="h-4 w-4 animate-spin mr-1" /> : null}Create list</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </SessionGuard>
    );
}
