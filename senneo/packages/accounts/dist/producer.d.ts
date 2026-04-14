import { RawMessage } from '@senneo/shared';
export declare function createProducer(brokers: string[], topic: string): Promise<{
    send: (messages: RawMessage[]) => Promise<void>;
    disconnect: () => Promise<void>;
}>;
//# sourceMappingURL=producer.d.ts.map