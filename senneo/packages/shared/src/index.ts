export * from './types';
export * from './proxy';

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToDate(id: string): Date {
  const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
  return new Date(Number(ms));
}

export function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function dateToBucket(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
