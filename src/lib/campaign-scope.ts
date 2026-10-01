import { prisma } from "@/lib/prisma";
import { canAccessSession, isStaff } from "@/lib/api-auth";

/**
 * Templates, contact lists and campaigns belong to an OWNER account. Owners and superadmins work
 * with their own; a STAFF user works with the ones of the owner of the session they are using
 * (read-only). Returns the owner's user id, or null when the staff user has no access.
 */
export async function resolveScopeUserId(user: { id: string; role: string }, sessionId?: string | null): Promise<string | null> {
    if (!isStaff(user.role)) return user.id;
    if (!sessionId) return null;
    const ok = await canAccessSession(user.id, user.role, sessionId);
    if (!ok) return null;
    const session = await prisma.session.findUnique({ where: { sessionId }, select: { userId: true } });
    return session?.userId ?? null;
}

/** Can this user read a resource owned by `ownerId`? (own, superadmin, or staff with access to one of the owner's sessions) */
export async function canReadOwnerResource(user: { id: string; role: string }, ownerId: string): Promise<boolean> {
    if (user.id === ownerId || user.role === "SUPERADMIN") return true;
    if (!isStaff(user.role)) return false;
    const grant = await prisma.sessionAccess.findFirst({ where: { userId: user.id, session: { userId: ownerId } }, select: { id: true } });
    return Boolean(grant);
}
