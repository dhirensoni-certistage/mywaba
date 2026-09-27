"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "@/components/dashboard/session-provider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@/components/ui/table";
import {
    Pagination,
    PaginationContent,
    PaginationItem,
} from "@/components/ui/pagination";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Search,
    Loader2,
    User,
    Upload,
    Download,
    Radio,
    RefreshCw,
    Plus,
    CheckCircle2,
    Send
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { SessionGuard } from "@/components/dashboard/session-guard";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface Contact {
    id: string;
    jid: string;
    name?: string;
    notify?: string;
    verifiedName?: string;
    profilePic?: string;
    remoteJidAlt?: string;
}

interface ParsedContact {
    name: string;
    phone: string;
}

export default function ContactListPage() {
    const { sessionId } = useSession();
    const router = useRouter();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(false);

    // Filters & Pagination
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [limit, setLimit] = useState("10");
    const [meta, setMeta] = useState({ total: 0, totalPages: 1 });

    // Import Dialog state
    const [importOpen, setImportOpen] = useState(false);
    const [importTab, setImportTab] = useState<"paste" | "file">("paste");
    const [pasteText, setPasteText] = useState("");
    const [parsedContacts, setParsedContacts] = useState<ParsedContact[]>([]);
    const [importing, setImporting] = useState(false);
    const [fileName, setFileName] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Export state
    const [exporting, setExporting] = useState(false);

    // Debounce Search
    useEffect(() => {
        const timer = setTimeout(() => {
            setPage(1);
            fetchContacts();
        }, 400);
        return () => clearTimeout(timer);
    }, [search]);

    // Fetch on page/session/limit change
    useEffect(() => {
        fetchContacts();
    }, [page, sessionId, limit]);

    const fetchContacts = async () => {
        if (!sessionId) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                limit: limit,
                search: search
            });

            const res = await fetch(`/api/contacts/${sessionId}?${params}`);
            const data = await res.json();

            if (res.ok) {
                setContacts(data.data || []);
                setMeta(data.meta || { total: 0, totalPages: 1 });
            } else {
                setContacts([]);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    // Parse contact lines from text
    const parseContactText = (text: string) => {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const parsed: ParsedContact[] = [];

        for (const line of lines) {
            // Check comma / semicolon / tab separated
            if (line.includes(",") || line.includes(";") || line.includes("\t")) {
                const parts = line.split(/[,;\t]+/).map(p => p.trim());
                if (parts.length >= 2) {
                    const firstIsNumber = /^\+?\d[\d\s-]{6,}$/.test(parts[0]);
                    const secondIsNumber = /^\+?\d[\d\s-]{6,}$/.test(parts[1]);

                    if (firstIsNumber) {
                        parsed.push({
                            phone: parts[0].replace(/\D/g, ""),
                            name: parts[1] || parts[0]
                        });
                    } else if (secondIsNumber) {
                        parsed.push({
                            phone: parts[1].replace(/\D/g, ""),
                            name: parts[0] || parts[1]
                        });
                    }
                }
            } else {
                // Just a phone number
                const clean = line.replace(/\D/g, "");
                if (clean.length >= 7) {
                    parsed.push({
                        phone: clean,
                        name: clean
                    });
                }
            }
        }

        // Deduplicate by phone
        const uniqueMap = new Map<string, ParsedContact>();
        for (const c of parsed) {
            if (!uniqueMap.has(c.phone)) {
                uniqueMap.set(c.phone, c);
            }
        }

        return Array.from(uniqueMap.values());
    };

    const handlePasteChange = (val: string) => {
        setPasteText(val);
        setParsedContacts(parseContactText(val));
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setFileName(file.name);
        const reader = new FileReader();
        reader.onload = (event) => {
            const content = event.target?.result as string;
            if (content) {
                // Check if VCF
                if (file.name.toLowerCase().endsWith(".vcf")) {
                    const vcfContacts: ParsedContact[] = [];
                    const cards = content.split("BEGIN:VCARD");
                    for (const card of cards) {
                        const fnMatch = card.match(/FN:(.+)/i);
                        const telMatch = card.match(/TEL.*:(.+)/i);
                        if (telMatch) {
                            const phone = telMatch[1].replace(/\D/g, "");
                            const name = fnMatch ? fnMatch[1].trim() : phone;
                            if (phone.length >= 7) {
                                vcfContacts.push({ name, phone });
                            }
                        }
                    }
                    setParsedContacts(vcfContacts);
                } else {
                    // CSV or TXT
                    setParsedContacts(parseContactText(content));
                }
            }
        };
        reader.readAsText(file);
    };

    const handleImportSubmit = async () => {
        if (!sessionId) return toast.error("No active session selected");
        if (parsedContacts.length === 0) return toast.error("No valid contacts found to import");

        setImporting(true);
        try {
            const res = await fetch(`/api/contacts/${sessionId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contacts: parsedContacts })
            });

            const data = await res.json();
            if (res.ok && data.status) {
                toast.success(`Successfully imported ${data.data?.imported || parsedContacts.length} contacts!`);
                setImportOpen(false);
                setPasteText("");
                setParsedContacts([]);
                setFileName(null);
                fetchContacts();
            } else {
                toast.error(data.message || "Failed to import contacts");
            }
        } catch (error: any) {
            console.error(error);
            toast.error("Error importing contacts. Please try again.");
        } finally {
            setImporting(false);
        }
    };

    // Export all contacts to CSV
    const handleExport = async () => {
        if (!sessionId) return toast.error("No active session selected");
        setExporting(true);
        try {
            const res = await fetch(`/api/contacts/${sessionId}?limit=all`);
            const data = await res.json();
            const list: Contact[] = data.data || [];

            if (list.length === 0) {
                toast.info("No contacts found to export");
                return;
            }

            const rows = [["Name", "Phone", "JID", "Verified Name"]];
            for (const c of list) {
                const phone = c.jid.split("@")[0] || c.remoteJidAlt || "";
                const name = c.name || c.notify || "";
                const verified = c.verifiedName || "";
                rows.push([`"${name.replace(/"/g, '""')}"`, `"${phone}"`, `"${c.jid}"`, `"${verified}"`]);
            }

            const csvContent = "data:text/csv;charset=utf-8," + rows.map(e => e.join(",")).join("\n");
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `contacts_${sessionId}_${new Date().toISOString().slice(0, 10)}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            toast.success(`Exported ${list.length} contacts successfully!`);
        } catch (e) {
            toast.error("Failed to export contacts");
        } finally {
            setExporting(false);
        }
    };

    // Quick action: send contacts to broadcast
    const handleSendToBroadcast = () => {
        router.push("/dashboard/broadcast");
    };

    return (
        <SessionGuard>
            <div className="space-y-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Contacts</h2>
                        <p className="text-sm text-muted-foreground">
                            Manage, import, and export your WhatsApp audience.
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleExport}
                            disabled={exporting || !sessionId || meta.total === 0}
                            className="flex-1 sm:flex-none"
                        >
                            {exporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                            Export CSV
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => setImportOpen(true)}
                            disabled={!sessionId}
                            className="flex-1 sm:flex-none"
                        >
                            <Upload className="w-4 h-4 mr-2" />
                            Import Contacts
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleSendToBroadcast}
                            disabled={!sessionId}
                            className="flex-1 sm:flex-none"
                        >
                            <Send className="w-4 h-4 mr-2" />
                            Broadcast
                        </Button>
                    </div>
                </div>

                <Card>
                    <CardHeader>
                        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                            <div className="space-y-1">
                                <CardTitle>Contact List</CardTitle>
                                <CardDescription>
                                    Total: {meta.total} contacts found
                                </CardDescription>
                            </div>
                            <div className="flex items-center gap-2 w-full md:w-auto">
                                <Select value={limit} onValueChange={(val) => { setLimit(val); setPage(1); }}>
                                    <SelectTrigger className="w-[120px]">
                                        <SelectValue placeholder="Per page" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {[10, 25, 50, 100].map((l) => (
                                            <SelectItem key={l} value={l.toString()}>
                                                {l} / page
                                            </SelectItem>
                                        ))}
                                        <SelectItem value="all">Show All</SelectItem>
                                    </SelectContent>
                                </Select>
                                <div className="relative w-full md:w-64">
                                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        placeholder="Search contacts..."
                                        className="pl-8 text-sm"
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                    />
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={fetchContacts}
                                    disabled={loading || !sessionId}
                                    title="Refresh"
                                >
                                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="rounded-md border overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-[60px]">Avatar</TableHead>
                                        <TableHead>Name / Display</TableHead>
                                        <TableHead className="hidden md:table-cell">Phone Number</TableHead>
                                        <TableHead className="hidden lg:table-cell">JID</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {loading ? (
                                        <TableRow>
                                            <TableCell colSpan={4} className="h-24 text-center">
                                                <div className="flex justify-center items-center gap-2 text-sm text-muted-foreground">
                                                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                                    Loading contacts...
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ) : contacts.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                                                <div className="flex flex-col items-center justify-center gap-2">
                                                    <User className="h-8 w-8 text-muted-foreground/40" />
                                                    <p className="text-sm">No contacts found.</p>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setImportOpen(true)}
                                                        className="mt-1"
                                                    >
                                                        <Upload className="w-3.5 h-3.5 mr-1" /> Import Contacts
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        contacts.map((contact) => (
                                            <TableRow key={contact.id}>
                                                <TableCell>
                                                    <Avatar className="h-8 w-8">
                                                        <AvatarImage src={contact.profilePic || ""} />
                                                        <AvatarFallback><User className="h-4 w-4" /></AvatarFallback>
                                                    </Avatar>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="font-medium text-sm">
                                                            {contact.name || contact.notify || "Unknown"}
                                                        </span>
                                                        {contact.verifiedName && (
                                                            <span className="text-xs text-green-600 flex items-center gap-1">
                                                                ✓ {contact.verifiedName}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell className="hidden md:table-cell text-sm font-mono">
                                                    {contact.jid.split("@")[0]}
                                                </TableCell>
                                                <TableCell className="hidden lg:table-cell font-mono text-xs text-muted-foreground">
                                                    {contact.jid}
                                                </TableCell>
                                            </TableRow>
                                        ))
                                    )}
                                </TableBody>
                            </Table>
                        </div>

                        {/* Pagination */}
                        {meta.totalPages > 1 && (
                            <div className="mt-4 flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">
                                    Showing {contacts.length} of {meta.total} contacts
                                </span>
                                <Pagination>
                                    <PaginationContent className="flex items-center gap-2">
                                        <PaginationItem>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={page <= 1}
                                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                            >
                                                Previous
                                            </Button>
                                        </PaginationItem>
                                        <PaginationItem>
                                            <span className="text-xs text-muted-foreground px-2">
                                                Page {page} of {meta.totalPages}
                                            </span>
                                        </PaginationItem>
                                        <PaginationItem>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={page >= meta.totalPages}
                                                onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                                            >
                                                Next
                                            </Button>
                                        </PaginationItem>
                                    </PaginationContent>
                                </Pagination>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Import Contacts Modal */}
                <Dialog open={importOpen} onOpenChange={setImportOpen}>
                    <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Upload className="h-5 w-5 text-primary" /> Import Contacts
                            </DialogTitle>
                            <DialogDescription>
                                Add contacts to your active WhatsApp session for broadcasting and organization.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4 py-2">
                            <Tabs value={importTab} onValueChange={(v) => setImportTab(v as any)}>
                                <TabsList className="grid grid-cols-2 w-full">
                                    <TabsTrigger value="paste">Paste Numbers</TabsTrigger>
                                    <TabsTrigger value="file">Upload File (CSV / VCF)</TabsTrigger>
                                </TabsList>

                                <TabsContent value="paste" className="space-y-3 pt-3">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-foreground">
                                            Paste Phone Numbers (One per line or Name, Phone)
                                        </label>
                                        <Textarea
                                            placeholder={"919876543210\nJohn Doe, 919876543211\n919876543212, Jane"}
                                            value={pasteText}
                                            onChange={(e) => handlePasteChange(e.target.value)}
                                            className="font-mono text-xs min-h-[140px]"
                                        />
                                        <p className="text-[11px] text-muted-foreground">
                                            Supports single numbers or comma/semicolon separated formats.
                                        </p>
                                    </div>
                                </TabsContent>

                                <TabsContent value="file" className="space-y-3 pt-3">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".csv,.txt,.vcf"
                                        className="hidden"
                                        onChange={handleFileUpload}
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="w-full h-24 border-dashed border-2 flex flex-col items-center justify-center gap-2"
                                    >
                                        <Upload className="h-6 w-6 text-muted-foreground" />
                                        <div className="text-center">
                                            <p className="text-sm font-medium">Click to select CSV, TXT, or VCF file</p>
                                            <p className="text-xs text-muted-foreground mt-0.5">
                                                {fileName || "Columns: Name, Phone or Phone only"}
                                            </p>
                                        </div>
                                    </Button>
                                </TabsContent>
                            </Tabs>

                            {/* Recognized Contacts Preview */}
                            {parsedContacts.length > 0 && (
                                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="font-semibold text-green-600 flex items-center gap-1">
                                            <CheckCircle2 className="h-4 w-4" />
                                            {parsedContacts.length} valid contacts recognized
                                        </span>
                                        <span className="text-muted-foreground">Preview (first 5)</span>
                                    </div>
                                    <div className="max-h-28 overflow-y-auto space-y-1">
                                        {parsedContacts.slice(0, 5).map((c, i) => (
                                            <div key={i} className="flex justify-between text-xs bg-background/80 px-2 py-1 rounded">
                                                <span className="font-medium truncate max-w-[180px]">{c.name}</span>
                                                <span className="font-mono text-muted-foreground">{c.phone}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <DialogFooter className="flex gap-2 justify-end">
                            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>
                                Cancel
                            </Button>
                            <Button
                                onClick={handleImportSubmit}
                                disabled={importing || parsedContacts.length === 0}
                            >
                                {importing ? (
                                    <>
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        Importing...
                                    </>
                                ) : (
                                    `Import ${parsedContacts.length} Contacts`
                                )}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </SessionGuard>
    );
}
