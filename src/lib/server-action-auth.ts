import { auth } from "./auth";
import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * Gets the currently authenticated user from Next Auth without requiring a Request object.
 * Used primarily for Server Actions.
 */
export async function getAuthenticatedUserForAction() {
    try {
        const session = await auth();
        
        if (session?.user?.id) {
            // Fetch full user data including role to ensure it's up to date
            const user = await prisma.user.findUnique({
                where: { id: session.user.id },
                select: { id: true, email: true, name: true, role: true }
            });

            if (user) {
                return user;
            }
        }
        return null;
    } catch (error: any) {
        // Next.js signals "this route must be dynamic" by throwing during static prerender.
        // Never swallow that, or the page would be prerendered as "Unauthorized".
        if (error?.digest === "DYNAMIC_SERVER_USAGE" || /Dynamic server usage/i.test(error?.message || "")) {
            throw error;
        }
        logger.error("Auth", "Error getting authenticated user for action:", error);
        return null;
    }
}
