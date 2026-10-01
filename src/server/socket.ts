import { Server, Socket } from "socket.io";
import { getToken } from "next-auth/jwt";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { canAccessSession, getAccessibleSessionIds } from "../lib/api-auth";

/**
 * Socket.IO authentication & authorization.
 *
 * Before this, the realtime channel had no auth at all: any client (even logged out) could
 * connect, emit "join-session <id>" and receive every message of that WhatsApp session, and
 * connection updates for all sessions were broadcast to every connected client.
 *
 * Now:
 *  - the handshake must carry a valid Auth.js session cookie (or a valid x-api-key)
 *  - each socket is auto-joined to its own user room and to the rooms of the sessions it may access
 *  - "join-session" is verified with the same canAccessSession() rule the REST API uses
 */

type SocketUser = { id: string; role: string };

// Auth.js uses the __Secure- prefix when served over https.
const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"];

async function authenticateSocket(socket: Socket): Promise<SocketUser | null> {
    const headers = socket.handshake.headers;

    // 1) API key (header or handshake auth payload) — same credential the REST API accepts
    const apiKey = (headers["x-api-key"] as string | undefined) || (socket.handshake.auth as any)?.apiKey;
    if (apiKey) {
        const user = await prisma.user.findUnique({ where: { apiKey }, select: { id: true, role: true } }).catch(() => null);
        if (user) return user;
    }

    // 2) Auth.js JWT cookie
    const cookie = headers.cookie;
    if (!cookie || !process.env.AUTH_SECRET) return null;

    for (const cookieName of SESSION_COOKIE_NAMES) {
        try {
            const token = await getToken({
                req: { headers: { cookie } },
                secret: process.env.AUTH_SECRET,
                cookieName,
                salt: cookieName,
            });
            const userId = (token as any)?.id as string | undefined;
            if (!userId) continue;
            // Always use the role stored in the database, never the one baked into the token.
            const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
            if (user) return user;
        } catch {
            // try the next cookie name
        }
    }
    return null;
}

export function setupSocket(io: Server) {
  io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);
      if (!user) {
        logger.warn("Socket", `Rejected unauthenticated socket from ${socket.handshake.address}`);
        return next(new Error("Unauthorized"));
      }
      socket.data.user = user;
      next();
    } catch (e) {
      logger.error("Socket", "Auth middleware error", e);
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user as SocketUser;
    logger.info("Socket", `Client connected: ${socket.id} (user ${user.id})`);

    // Own notification room + every session this user is allowed to see.
    socket.join(`user:${user.id}`);
    try {
      const sessionIds = await getAccessibleSessionIds(user.id, user.role);
      if (sessionIds.length > 0) socket.join(sessionIds);
    } catch (e) {
      logger.error("Socket", "Failed to resolve accessible sessions", e);
    }

    socket.on("disconnect", () => {
      logger.info("Socket", "Client disconnected:", socket.id);
    });

    // Handle joining room for specific WA session — verified against the user's access
    socket.on("join-session", async (sessionId: string) => {
        if (typeof sessionId !== "string" || !sessionId) return;
        try {
          const allowed = await canAccessSession(user.id, user.role, sessionId);
          if (!allowed) {
            logger.warn("Socket", `User ${user.id} denied joining session room ${sessionId}`);
            socket.emit("error", { message: "Forbidden" });
            return;
          }
          socket.join(sessionId);
          logger.debug("Socket", `Socket ${socket.id} joined session room: ${sessionId}`);
        } catch (e) {
          logger.error("Socket", "join-session error", e);
        }
    });

    // Handle joining user-specific room for notifications — only your own room
    socket.on("join-user-room", (userId: string) => {
        if (userId !== user.id) {
          logger.warn("Socket", `User ${user.id} tried to join notification room of ${userId}`);
          return;
        }
        socket.join(`user:${userId}`);
    });
  });
}
