import { ChannelCheckpoint } from '@senneo/shared';
export declare function loadCheckpoints(): Promise<void>;
export declare function getCheckpoint(channelId: string): ChannelCheckpoint | null;
export declare function getAllCheckpoints(): Readonly<Record<string, ChannelCheckpoint>>;
export declare function setCheckpoint(cp: ChannelCheckpoint): void;
export declare function clearCheckpoint(channelId: string): void;
export declare function flush(): Promise<void>;
export declare function flushCheckpoint(channelId: string): Promise<boolean>;
//# sourceMappingURL=checkpoint.d.ts.map