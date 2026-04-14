import { Router, Request, Response, NextFunction } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
export interface AuthUser {
    username: string;
    displayName: string;
    role: 'admin' | 'user';
}
export declare function requireAuth(req: Request, res: Response, next: NextFunction): void;
export declare function requireAdmin(req: Request, res: Response, next: NextFunction): void;
export declare function initAuthSchema(db: CassandraClient): Promise<void>;
export declare function authRouter(db: CassandraClient): Router;
//# sourceMappingURL=auth.d.ts.map