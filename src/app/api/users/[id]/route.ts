import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, isAdmin } from "@/lib/api-auth";
import bcrypt from "bcryptjs";

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const user = await getAuthenticatedUser(request);

    // Only SUPERADMIN can update users
    if (!user || !isAdmin(user.role)) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 403 });
    }

    const { id } = await params;

    try {
        const body = await request.json();
        const { name, email, password, role } = body;

        // Prevent modifying own role to lock oneself out (optional safety)
        if (id === user.id && role && role !== "SUPERADMIN") {
            // Allow update but maybe warn? For now let it be.
        }

        if (role && !["SUPERADMIN", "OWNER", "STAFF"].includes(role)) {
            return NextResponse.json({ status: false, message: "Invalid role", error: "Invalid role" }, { status: 400 });
        }
        if (id === user.id && role && role !== "SUPERADMIN") {
            return NextResponse.json({ status: false, message: "You cannot remove your own Super Admin role", error: "You cannot remove your own Super Admin role" }, { status: 400 });
        }
        if (email) {
            const clash = await prisma.user.findFirst({ where: { email, NOT: { id } }, select: { id: true } });
            if (clash) return NextResponse.json({ status: false, message: "Another user already has that email", error: "Another user already has that email" }, { status: 409 });
        }

        const updateData: any = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (role) updateData.role = role;
        if (password) {
            if (String(password).length < 6) return NextResponse.json({ status: false, message: "Password must be at least 6 characters", error: "Password must be at least 6 characters" }, { status: 400 });
            updateData.password = await bcrypt.hash(password, 10);
        }

        const updatedUser = await prisma.user.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                updatedAt: true
            }
        });

        return NextResponse.json({ status: true, message: role ? "User updated. The new role applies within a minute, or immediately after they log in again." : "User updated successfully", data: updatedUser });

    } catch (error) {
        console.error("Update user error:", error);
        const msg = (error as { code?: string })?.code === "P2025" ? "User not found" : "Failed to update user";
        return NextResponse.json({ status: false, message: msg, error: msg }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const user = await getAuthenticatedUser(request);

    // Only SUPERADMIN can delete users
    if (!user || !isAdmin(user.role)) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 403 });
    }

    const { id } = await params;

    if (id === user.id) {
        return NextResponse.json({ status: false, message: "Cannot delete yourself", error: "Cannot delete yourself" }, { status: 400 });
    }

    try {
        await prisma.user.delete({ where: { id } });
        return NextResponse.json({ status: true, message: "User deleted successfully" });
    } catch (error) {
        console.error("Delete user error:", error);
        return NextResponse.json({ status: false, message: "Failed to delete user", error: "Failed to delete user" }, { status: 500 });
    }
}
