import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { normalizeRecipient } from "@/modules/whatsapp/broadcast";

/**
 * POST /api/messages/:sessionId/broadcast/recipients/parse  (multipart/form-data, field "file")
 *
 * Accepts .xlsx / .xls / .csv / .txt. Returns the detected columns and one row per recipient:
 *   { number, name, vars: { <every column lower-cased>: value } }
 * so the dashboard can preview the list and the broadcast can use {name} / {column} placeholders.
 *
 * Column detection (case-insensitive header match):
 *   number  → phone | number | mobile | whatsapp | contact | msisdn | tel  (or the first column whose values look like numbers)
 *   name    → name | full name | first name | customer | client
 */

const MAX_ROWS = 5000;
const NUMBER_HEADERS = ["phone", "number", "mobile", "whatsapp", "contact", "msisdn", "tel", "phone number", "mobile number", "contact number", "whatsapp number"];
const NAME_HEADERS = ["name", "full name", "fullname", "first name", "firstname", "customer", "client", "customer name", "client name"];

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    const src = text.replace(/^﻿/, "");
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === "," || ch === ";" || ch === "\t") { row.push(field); field = ""; continue; }
        if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && src[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.some(c => c.trim() !== "")) rows.push(row);
            row = [];
            continue;
        }
        field += ch;
    }
    row.push(field);
    if (row.some(c => c.trim() !== "")) rows.push(row);
    return rows;
}

function cellToString(v: unknown): string {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
        const o = v as any;
        if (o instanceof Date) return o.toISOString().slice(0, 10);
        if (typeof o.text === "string") return o.text;               // hyperlink / rich text
        if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text ?? "").join("");
        if (o.result !== undefined) return cellToString(o.result);    // formula
        return String(o);
    }
    if (typeof v === "number") {
        // Excel stores phone numbers as doubles; avoid "9.19876543210e+11"
        return Number.isInteger(v) ? String(v) : v.toLocaleString("fullwide", { useGrouping: false });
    }
    return String(v);
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = row.values as unknown[];
        // exceljs rows are 1-indexed: values[0] is empty
        const cells = values.slice(1).map(cellToString);
        if (cells.some(c => c.trim() !== "")) rows.push(cells);
    });
    return rows;
}

function looksLikeNumber(s: string): boolean {
    const digits = s.replace(/[^0-9]/g, "");
    return digits.length >= 7 && digits.length <= 15 && digits.length >= s.replace(/[\s+()-]/g, "").length * 0.8;
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }
        const { sessionId } = await params;
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
        }

        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
            return NextResponse.json({ status: false, message: "No file provided (field name: file)" }, { status: 400 });
        }
        if (file.size > 10 * 1024 * 1024) {
            return NextResponse.json({ status: false, message: "File too large (max 10 MB)" }, { status: 400 });
        }

        const name = file.name.toLowerCase();
        const buffer = Buffer.from(await file.arrayBuffer());
        let table: string[][];
        if (name.endsWith(".xlsx") || name.endsWith(".xlsm") || name.endsWith(".xls")) {
            table = await parseXlsx(buffer);
        } else {
            table = parseCsv(buffer.toString("utf8"));
        }

        if (table.length === 0) {
            return NextResponse.json({ status: false, message: "The file is empty" }, { status: 400 });
        }

        // Header detection: first row is a header unless its cells look like phone numbers
        const first = table[0].map(c => c.trim());
        const hasHeader = !first.some(looksLikeNumber);
        const headers = hasHeader
            ? first.map((h, i) => (h || `column${i + 1}`).toLowerCase())
            : first.map((_, i) => `column${i + 1}`);
        const dataRows = hasHeader ? table.slice(1) : table;

        let numberIdx = headers.findIndex(h => NUMBER_HEADERS.includes(h));
        if (numberIdx === -1) numberIdx = headers.findIndex(h => NUMBER_HEADERS.some(k => h.includes(k)));
        if (numberIdx === -1) {
            // first column where most values look like numbers
            const sample = dataRows.slice(0, 50);
            numberIdx = headers.findIndex((_, i) => sample.filter(r => looksLikeNumber((r[i] || "").trim())).length >= Math.max(1, sample.length * 0.6));
        }
        if (numberIdx === -1) {
            return NextResponse.json({ status: false, message: "Could not find a phone-number column. Name it 'phone', 'number', 'mobile' or 'whatsapp'." }, { status: 400 });
        }

        let nameIdx = headers.findIndex(h => NAME_HEADERS.includes(h));
        if (nameIdx === -1) nameIdx = headers.findIndex((h, i) => i !== numberIdx && h.includes("name"));

        const rows: { number: string; name: string | null; vars: Record<string, string> }[] = [];
        const invalid: string[] = [];
        const seen = new Set<string>();
        for (const r of dataRows.slice(0, MAX_ROWS)) {
            const rawNumber = (r[numberIdx] || "").trim();
            if (!rawNumber) continue;
            const jid = normalizeRecipient(rawNumber);
            if (!jid) { invalid.push(rawNumber); continue; }
            if (seen.has(jid)) continue;
            seen.add(jid);
            const vars: Record<string, string> = {};
            headers.forEach((h, i) => { vars[h] = (r[i] || "").trim(); });
            const nm = nameIdx >= 0 ? (r[nameIdx] || "").trim() : "";
            if (nm) vars.name = nm;
            rows.push({ number: jid.split("@")[0], name: nm || null, vars });
        }

        return NextResponse.json({
            status: true,
            data: {
                columns: headers,
                numberColumn: headers[numberIdx],
                nameColumn: nameIdx >= 0 ? headers[nameIdx] : null,
                rows,
                invalid,
                truncated: dataRows.length > MAX_ROWS ? dataRows.length - MAX_ROWS : 0
            }
        });
    } catch (e: any) {
        console.error("Recipient file parse error", e);
        return NextResponse.json({ status: false, message: e?.message || "Failed to parse file" }, { status: 500 });
    }
}
