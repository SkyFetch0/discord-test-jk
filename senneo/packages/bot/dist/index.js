"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-explicit-any */
require("dotenv/config");
const kafkajs_1 = require("kafkajs");
const { Client } = require('discord.js-selfbot-v13');
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? 'localhost:9092';
const KAFKA_TOPIC = process.env.KAFKA_TOPIC ?? 'messages';
const TOKEN = process.env.BOT_TOKEN ?? '';
async function main() {
    if (!TOKEN) {
        console.error('[bot] BOT_TOKEN not set');
        process.exit(1);
    }
    const kafka = new kafkajs_1.Kafka({ clientId: 'senneo-bot', brokers: KAFKA_BROKERS.split(',') });
    const producer = kafka.producer({ allowAutoTopicCreation: true });
    await producer.connect();
    const client = new Client({});
    client.on('messageCreate', async (msg) => {
        if (!msg.guild)
            return;
        const attachmentList = [...msg.attachments.values()];
        const raw = {
            messageId: msg.id,
            channelId: msg.channelId,
            guildId: msg.guild.id,
            authorId: msg.author.id,
            authorName: msg.author.username,
            authorDiscriminator: msg.author.discriminator,
            nick: msg.member?.nickname ?? null,
            content: msg.content,
            ts: msg.createdAt.toISOString(),
            attachments: attachmentList.map((a) => a.url),
            mediaUrls: attachmentList.map((a) => a.url),
            embedTypes: msg.embeds.map((e) => e.type ?? 'unknown'),
            badgeMask: (() => { let m = msg.author.flags?.bitfield ?? 0; try {
                if (msg.author.avatar?.startsWith('a_'))
                    m |= (1 << 24);
            }
            catch { } try {
                if (msg.member?.premiumSince)
                    m |= (1 << 25);
            }
            catch { } return m; })(),
            roles: msg.member ? [...msg.member.roles.cache.keys()] : [],
            editedTs: msg.editedAt?.toISOString() ?? null,
            referencedMessageId: msg.reference?.messageId ?? null,
            tts: !!msg.tts,
            stickerNames: msg.stickers ? [...msg.stickers.values()].map((s) => s.name) : [],
            stickerIds: msg.stickers ? [...msg.stickers.values()].map((s) => s.id) : [],
            mediaType: attachmentList.length > 0
                ? attachmentList[0].contentType ?? null
                : null,
            authorAvatar: msg.author.avatar ?? null,
        };
        try {
            await producer.send({ topic: KAFKA_TOPIC, messages: [{ key: raw.channelId, value: JSON.stringify(raw) }] });
        }
        catch (err) {
            console.error('[bot] Kafka send error:', err);
        }
    });
    client.on('error', (err) => console.error('[bot] Discord error:', err));
    await client.login(TOKEN);
    console.log('[bot] Ready');
}
main().catch(err => { console.error('[bot] Fatal:', err); process.exit(1); });
//# sourceMappingURL=index.js.map