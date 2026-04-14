"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.snowflakeToDate = snowflakeToDate;
exports.snowflakeToMs = snowflakeToMs;
exports.dateToBucket = dateToBucket;
exports.sleep = sleep;
__exportStar(require("./types"), exports);
__exportStar(require("./proxy"), exports);
const DISCORD_EPOCH = 1420070400000n;
function snowflakeToDate(id) {
    const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
    return new Date(Number(ms));
}
function snowflakeToMs(id) {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
function dateToBucket(date) {
    return Math.floor(date.getTime() / 86_400_000);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=index.js.map