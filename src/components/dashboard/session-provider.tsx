"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { getCookie, setCookie } from "@/lib/client-cookie";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { io } from "socket.io-client";

interface Session {
    id: string;
    sessionId: string;
    name: string;
    status: string;
}

interface SessionContextType {
    sessions: Session[];
    sessionId: string;
    setSessionId: (id: string) => void;
    refreshSessions: () => Promise<void>;
    loading: boolean;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
    const [sessions, setSessions] = useState<Session[]>([]);
    const [sessionId, setSessionIdState] = useState<string>("");
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    const fetchSessions = async () => {
        try {
            const res = await fetch('/api/sessions');
            if (res.ok) {
                const responseData = await res.json();
                const data = responseData?.data || [];
                setSessions(data);

                // Sync with cookie
                const cookieId = getCookie("sessionId");
                if (cookieId && data.find((s: Session) => s.sessionId === cookieId)) {
                    setSessionIdState(cookieId);
                } else if (data.length > 0) {
                    const first = data[0].sessionId;
                    setSessionIdState(first);
                    setCookie("sessionId", first);
                } else {
                    setSessionIdState("");
                }
            }
        } catch (error) {
            console.error(error);
            toast.error("Failed to fetch sessions");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSessions();

        const socketInstance = io({
            path: "/api/socket/io",
            addTrailingSlash: false,
        });

        socketInstance.on("connection.update", (data: { sessionId?: string; status: string }) => {
            if (data?.sessionId) {
                setSessions(prev => prev.map(s => {
                    if (s.sessionId === data.sessionId) {
                        return { ...s, status: data.status };
                    }
                    return s;
                }));
            }
        });

        return () => {
            socketInstance.disconnect();
        };
    }, []);

    const setSessionId = (id: string) => {
        setSessionIdState(id);
        setCookie("sessionId", id); // Sync Cookie
        router.refresh(); // Sync Server Components
    };

    return (
        <SessionContext.Provider value={{ sessions, sessionId, setSessionId, refreshSessions: fetchSessions, loading }}>
            {children}
        </SessionContext.Provider>
    );
}

export function useSession() {
    const context = useContext(SessionContext);
    if (!context) {
        throw new Error("useSession must be used within a SessionProvider");
    }
    return context;
}
