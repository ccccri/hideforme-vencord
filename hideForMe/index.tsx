/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * HideForMe: hide single messages or clear a whole chat only for you ("delete for me" /
 * WhatsApp-style "clear chat"), with a history to bring them back.
 * Nothing is sent to Discord: it only changes what this client displays.
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { get, set } from "@api/DataStore";
import { addMessagePopoverButton, removeMessagePopoverButton } from "@api/MessagePopover";
import { Button } from "@components/Button";
import { DeleteIcon } from "@components/Icons";
import definePlugin, { IconComponent } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, closeModal, FluxDispatcher, GuildMemberStore, Menu, MessageStore, Modal, openModal, React, SelectedChannelStore, showToast, useEffect, UserStore, useState } from "@webpack/common";

const STORE_KEY = "HideForMe_v1";
const CLEARED_KEY = "HideForMe_cleared_v1";

interface ClearedEntry {
    upTo: string;
    at: number;
}

interface HiddenEntry {
    id: string;
    channelId: string;
    author: string;
    content: string;
    timestamp: number;
    hiddenAt: number;
}

let loaded = false;
let ready: Promise<void> = Promise.resolve();
let hidden: Record<string, HiddenEntry> = {};
let cleared: Record<string, ClearedEntry> = {};
let styleEl: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let sweepQueued = false;
const listeners = new Set<() => void>();

const DIVIDER_ATTR = "data-vc-hide-divider";
const CLEARED_ATTR = "data-vc-cleared";
const SKELETON_ATTR = "data-vc-skeleton";
const ORPHAN_ATTR = "data-vc-orphan";
const GROUP_GAP_MS = 7 * 60 * 1000;
const BANNER_ID = "vc-hide-banner";

// Once the loaded page reaches the cleared point, older history is never shown:
// tell Discord there is nothing more to load so it stops showing the loading placeholder.
function loadInterceptor(ev: any) {
    if (ev?.type === "LOAD_MESSAGES_SUCCESS" && cleared[ev.channelId] && ev.hasMoreBefore) {
        if ((ev.messages ?? []).some((m: Message) => isCleared(ev.channelId, m.id))) ev.hasMoreBefore = false;
    }
    return false;
}

function isLoadingSkeleton(el: Element) {
    return el.tagName === "DIV" && !el.id && el.getAttribute("aria-hidden") === "true" && el.childElementCount === 0;
}

function updateBanner(channelId: string | undefined, visibleCount: number) {
    const existing = document.getElementById(BANNER_ID);
    const host = document.querySelector('main[class*="chatContent"]');
    if (!channelId || !cleared[channelId] || visibleCount > 0 || !host) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const el = document.createElement("div");
    el.id = BANNER_ID;
    el.style.cssText = "position:absolute;inset:0 0 80px 0;display:flex;align-items:center;justify-content:center;gap:6px;pointer-events:none;color:var(--text-muted);font-size:14px;opacity:.75;z-index:1";
    const text = document.createElement("span");
    text.textContent = "Chat cleared (only for you) \u2014";
    const btn = document.createElement("button");
    btn.textContent = "Show again";
    btn.style.cssText = "pointer-events:auto;cursor:pointer;padding:0;border:0;background:none;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:2px";
    btn.onmouseenter = () => (el.style.opacity = "1");
    btn.onmouseleave = () => (el.style.opacity = ".75");
    btn.onclick = () => void showAll(channelId);
    el.append(text, btn);
    host.append(el);
}

const isSnowflake = (v: unknown): v is string => typeof v === "string" && /^\d{1,25}$/.test(v);
const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

// stored data may come from an older/corrupted profile: keep only well-formed entries
function sanitizeHidden(raw: unknown): Record<string, HiddenEntry> {
    const out: Record<string, HiddenEntry> = {};
    if (!isRecord(raw)) return out;
    for (const [id, e] of Object.entries(raw)) {
        if (!isSnowflake(id) || !isRecord(e) || !isSnowflake(e.channelId)) continue;
        out[id] = {
            id,
            channelId: e.channelId,
            author: String(e.author ?? "?"),
            content: String(e.content ?? ""),
            timestamp: Number(e.timestamp) || 0,
            hiddenAt: Number(e.hiddenAt) || 0
        };
    }
    return out;
}

function sanitizeCleared(raw: unknown): Record<string, ClearedEntry> {
    const out: Record<string, ClearedEntry> = {};
    if (!isRecord(raw)) return out;
    for (const [ch, c] of Object.entries(raw)) {
        if (isSnowflake(ch) && isRecord(c) && isSnowflake(c.upTo)) out[ch] = { upTo: c.upTo, at: Number(c.at) || 0 };
    }
    return out;
}

function displayName(channelId: string, author: any): string {
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    const nick = guildId ? GuildMemberStore.getNick(guildId, author.id) : null;
    return nick || author.globalName || author.global_name || author.username || "?";
}

function isMessageRow(el: Element) {
    return el.tagName === "LI" && el.id.startsWith("chat-messages-");
}

// Hide date / "new messages" separators whose messages are all hidden.
function sweepDividers() {
    sweepQueued = false;
    document.querySelectorAll(`[${DIVIDER_ATTR}]`).forEach(el => el.removeAttribute(DIVIDER_ATTR));
    document.querySelectorAll(`[${CLEARED_ATTR}]`).forEach(el => el.removeAttribute(CLEARED_ATTR));
    document.querySelectorAll(`[${SKELETON_ATTR}]`).forEach(el => el.removeAttribute(SKELETON_ATTR));
    document.querySelectorAll(`[${ORPHAN_ATTR}]`).forEach(el => el.removeAttribute(ORPHAN_ATTR));
    const currentChannel = SelectedChannelStore.getChannelId();
    if (!Object.keys(hidden).length && !Object.keys(cleared).length) {
        updateBanner(undefined, 0);
        return;
    }

    // hide everything older than the "clear chat" point, including messages loaded later by scrolling
    if (Object.keys(cleared).length) {
        document.querySelectorAll('li[id^="chat-messages-"]').forEach(li => {
            const parts = li.id.split("-");
            if (parts.length === 4 && isCleared(parts[2], parts[3])) li.setAttribute(CLEARED_ATTR, "");
        });
    }

    document.querySelectorAll('[data-list-id="chat-messages"]').forEach(list => {
        const rows = Array.from(list.children);
        if (currentChannel && cleared[currentChannel]) rows.filter(isLoadingSkeleton).forEach(r => r.setAttribute(SKELETON_ATTR, ""));

        // Discord only prints the author on the first message of a group. If that one is hidden, the
        // messages that follow lose their header: label the first visible one with its own author.
        let prev: { authorId: string; time: number; } | null = null;
        let skipped = false;
        for (const row of rows) {
            if (row.getAttribute("role") === "separator" || row.querySelector(':scope > [role="separator"]')) {
                prev = null;
                skipped = false;
                continue;
            }
            if (!isMessageRow(row)) continue;
            const [, , channelId, msgId] = row.id.split("-");
            if (hidden[msgId] || row.hasAttribute(CLEARED_ATTR)) {
                skipped = true;
                continue;
            }
            const msg = MessageStore.getMessage(channelId, msgId);
            const author = msg?.author;
            const time = msg ? new Date(msg.timestamp as any).getTime() : 0;
            // Discord groups same-author messages sent less than 7 minutes apart
            const continuesVisible = !!prev && !!author && prev.authorId === author.id && time - prev.time < GROUP_GAP_MS;
            if (skipped && author && !row.querySelector('h3 [class*="username"]') && !continuesVisible) {
                row.setAttribute(ORPHAN_ATTR, displayName(channelId, author));
            }
            prev = author ? { authorId: author.id, time } : null;
            skipped = false;
        }
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const isDivider = row.getAttribute("role") === "separator" || !!row.querySelector(':scope > [role="separator"]');
            if (!isDivider) continue;

            let total = 0;
            let visible = 0;
            for (let j = i + 1; j < rows.length; j++) {
                const next = rows[j];
                if (next.getAttribute("role") === "separator" || next.querySelector(':scope > [role="separator"]')) break;
                if (!isMessageRow(next)) continue;
                total++;
                const msgId = next.id.slice(next.id.lastIndexOf("-") + 1);
                if (!hidden[msgId] && !next.hasAttribute(CLEARED_ATTR)) visible++;
            }
            if (total > 0 && visible === 0) row.setAttribute(DIVIDER_ATTR, "");
        }
    });

    let visibleCount = 0;
    document.querySelectorAll('li[id^="chat-messages-"]').forEach(li => {
        const msgId = li.id.slice(li.id.lastIndexOf("-") + 1);
        if (!hidden[msgId] && !li.hasAttribute(CLEARED_ATTR)) visibleCount++;
    });
    updateBanner(currentChannel, visibleCount);
}

function queueSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    requestAnimationFrame(sweepDividers);
}

function refresh() {
    if (styleEl) {
        styleEl.textContent = Object.keys(hidden)
            .map(id => `li[id$="-${id}"]{display:none!important}`)
            .concat(`[${DIVIDER_ATTR}],[${CLEARED_ATTR}],[${SKELETON_ATTR}]{display:none!important}`)
            .concat(`li[${ORPHAN_ATTR}]::before{content:attr(${ORPHAN_ATTR});display:block;padding:6px 16px 0 80px;font-size:12px;font-weight:500;color:var(--text-muted)}`)
            .join("\n");
    }
    queueSweep();
    listeners.forEach(l => l());
}

async function persist() {
    // never write before the stored data has been read, or an empty state would overwrite it
    if (!loaded) return;
    await Promise.all([set(STORE_KEY, hidden), set(CLEARED_KEY, cleared)]);
    refresh();
}

function isCleared(channelId: string, msgId: string) {
    const c = cleared[channelId];
    if (!c) return false;
    try {
        return BigInt(msgId) <= BigInt(c.upTo);
    } catch {
        return false;
    }
}

function toEntry(m: Message): HiddenEntry {
    return {
        id: m.id,
        channelId: m.channel_id,
        author: (m.author as any)?.globalName ?? m.author?.username ?? "?",
        content: m.content || (m.attachments?.length ? "[attachment]" : m.embeds?.length ? "[embed]" : "[empty]"),
        timestamp: new Date(m.timestamp as any).getTime(),
        hiddenAt: Date.now()
    };
}

async function hideMessages(messages: Message[]) {
    await ready;
    if (!loaded) return;
    for (const m of messages) hidden[m.id] = toEntry(m);
    return persist();
}

function loadedMessages(channelId: string): Message[] {
    return [...(MessageStore.getMessages(channelId)?._array ?? [])];
}

async function clearChat(channelId: string) {
    await ready;
    if (!loaded) return;
    const ids = loadedMessages(channelId).map(m => m.id);
    const last = ChannelStore.getChannel(channelId)?.lastMessageId;
    if (last) ids.push(last);
    if (!ids.length) {
        showToast({ text: "Nothing to clear here", variant: "default" });
        return;
    }
    const upTo = ids.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a));
    cleared[channelId] = { upTo, at: Date.now() };
    await persist();
    showToast({ text: "Chat cleared (only for you)", variant: "success" });
}

async function showAll(channelId?: string) {
    await ready;
    if (!loaded) return;
    let n = 0;
    let wasCleared = false;
    for (const id of Object.keys(cleared)) {
        if (!channelId || id === channelId) {
            delete cleared[id];
            wasCleared = true;
        }
    }
    for (const id of Object.keys(hidden)) {
        if (!channelId || hidden[id].channelId === channelId) {
            delete hidden[id];
            n++;
        }
    }
    await persist();
    if (!n && !wasCleared) showToast({ text: "Nothing to show again", variant: "default" });
    else showToast({ text: wasCleared ? "Chat shown again" : `${n} message${n === 1 ? "" : "s"} shown again`, variant: "success" });
}

async function restore(id: string) {
    await ready;
    if (!loaded) return;
    delete hidden[id];
    await persist();
}

function useHidden() {
    const [, bump] = useState(0);
    useEffect(() => {
        const l = () => bump(n => n + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return hidden;
}

function channelLabel(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return channelId;
    if (ch.name) return `#${ch.name}`;
    const recipients = (ch.recipients ?? []).map((u: string) => UserStore.getUser(u)?.username).filter(Boolean);
    return recipients.length ? `DM: ${recipients.join(", ")}` : channelId;
}

function HistoryModal({ modalProps, close, channelId }: { modalProps: any; close: () => void; channelId: string; }) {
    const data = useHidden();
    const [onlyThis, setOnlyThis] = useState(true);
    const clearedEntries = Object.entries(cleared).filter(([ch]) => !onlyThis || ch === channelId);
    const entries = Object.values(data)
        .filter(e => !onlyThis || e.channelId === channelId)
        .sort((a, b) => b.hiddenAt - a.hiddenAt);

    return (
        <Modal
            {...modalProps}
            title={`Hidden messages (${entries.length})`}
            actions={[{ text: "Close", variant: "secondary", onClick: close }]}
        >
            <div>
                <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
                    <Button size="small" onClick={() => setOnlyThis(v => !v)}>
                        {onlyThis ? "Show all channels" : "Only this channel"}
                    </Button>
                    <Button size="small" onClick={() => showAll(onlyThis ? channelId : undefined)}>
                        Restore all{onlyThis ? " (this channel)" : ""}
                    </Button>
                </div>
                {clearedEntries.map(([ch, c]) => (
                    <div key={ch} style={{
                        display: "flex", gap: 12, alignItems: "center", padding: "8px 0",
                        borderBottom: "1px solid var(--background-modifier-accent)"
                    }}>
                        <div style={{ flex: 1, minWidth: 0, color: "var(--text-default)" }}>
                            Chat cleared: {channelLabel(ch)}
                            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                all messages before {new Date(c.at).toLocaleString()}
                            </div>
                        </div>
                        <Button size="small" onClick={() => showAll(ch)}>Restore</Button>
                    </div>
                ))}
                {entries.length === 0 && clearedEntries.length === 0 && <div style={{ padding: 16, color: "var(--text-muted)" }}>No hidden messages.</div>}
                {entries.map(e => (
                    <div key={e.id} style={{
                        display: "flex", gap: 12, alignItems: "center", padding: "8px 0",
                        borderBottom: "1px solid var(--background-modifier-accent)"
                    }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                {e.author} · {channelLabel(e.channelId)} · {new Date(e.timestamp).toLocaleString()}
                            </div>
                            <div style={{ color: "var(--text-default)", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
                                {e.content.length > 300 ? e.content.slice(0, 300) + "…" : e.content}
                            </div>
                        </div>
                        <Button size="small" onClick={() => restore(e.id)}>Restore</Button>
                    </div>
                ))}
            </div>
        </Modal>
    );
}

function openHistory() {
    const channelId = SelectedChannelStore.getChannelId();
    const key = openModal(props => <HistoryModal modalProps={props} close={() => closeModal(key)} channelId={channelId} />);
}

const svg = (d: string): IconComponent => ({ height = 20, width = 20, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
        <path fill="currentColor" d={d} />
    </svg>
);
// broom-ish "clear" icon, eye icon, clock-history icon (Material design paths)
const ClearIcon = svg("M19.36 2.72l1.42 1.42-5.72 5.71c1.07 1.54 1.22 3.39.32 4.59L9.06 8.12c1.2-.9 3.05-.75 4.59.32l5.71-5.72zM5.93 17.57c-2.01-2.01-3.24-4.41-3.58-6.65l4.88-2.09 7.44 7.44-2.09 4.88c-2.24-.34-4.64-1.57-6.65-3.58z");
const EyeIcon = svg("M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z");
const HistoryIcon = svg("M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z");

const Buttons: ChatBarButtonFactory = ({ isMainChat }) => {
    // hooks must run on every render, before any early return
    const data = useHidden();
    if (!isMainChat) return null;
    const channelId = SelectedChannelStore.getChannelId();
    const count = Object.values(data).filter(e => e.channelId === channelId).length;
    return (
        <>
            <ChatBarButton tooltip="Clear chat (only for me)" onClick={() => clearChat(channelId)}>
                <ClearIcon />
            </ChatBarButton>
            <ChatBarButton tooltip="Show all hidden messages in this chat" onClick={() => showAll(channelId)}>
                <EyeIcon />
            </ChatBarButton>
            <ChatBarButton tooltip={`Hidden messages history (${count})`} onClick={openHistory}>
                <HistoryIcon />
            </ChatBarButton>
        </>
    );
};

const messageMenu: NavContextMenuPatchCallback = (children, { message }) => {
    if (!message) return;
    children.push(
        <Menu.MenuItem
            id="vc-hide-for-me"
            key="vc-hide-for-me"
            label="Hide for me"
            color="danger"
            action={() => hideMessages([message])}
        />,
        <Menu.MenuItem
            id="vc-clear-chat-for-me"
            key="vc-clear-chat-for-me"
            label="Clear chat (only for me)"
            action={() => clearChat(message.channel_id)}
        />,
        <Menu.MenuItem
            id="vc-hidden-history"
            key="vc-hidden-history"
            label="Hidden messages history"
            action={openHistory}
        />
    );
};

export default definePlugin({
    name: "HideForMe",
    description: "Hide single messages or clear a whole chat only for you, with a history to restore them. Local only: nothing changes for other people.",
    authors: [{ name: "cri", id: 0n }],
    dependencies: ["ChatInputButtonAPI", "MessagePopoverAPI"],
    contextMenus: { message: messageMenu },

    async start() {
        // register the UI first: the chat bar may already be rendered when the data finishes loading
        addChatBarButton("HideForMe", Buttons, ClearIcon);
        addMessagePopoverButton("HideForMe", (msg: Message) => ({
            label: "Hide for me",
            icon: DeleteIcon,
            message: msg,
            channel: ChannelStore.getChannel(msg.channel_id),
            dangerous: true,
            onClick: () => hideMessages([msg])
        } as any), DeleteIcon);

        let done!: () => void;
        ready = new Promise<void>(r => (done = r));
        hidden = sanitizeHidden(await get(STORE_KEY));
        cleared = sanitizeCleared(await get(CLEARED_KEY));
        loaded = true;
        done();
        styleEl = document.createElement("style");
        styleEl.id = "vc-hide-for-me";
        document.head.append(styleEl);
        refresh();
        FluxDispatcher.addInterceptor(loadInterceptor);
        observer = new MutationObserver(queueSweep);
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        loaded = false;
        removeChatBarButton("HideForMe");
        removeMessagePopoverButton("HideForMe");
        observer?.disconnect();
        observer = null;
        const ints = (FluxDispatcher as any)._interceptors;
        const idx = ints?.indexOf(loadInterceptor) ?? -1;
        if (idx >= 0) ints.splice(idx, 1);
        document.getElementById(BANNER_ID)?.remove();
        document.querySelectorAll(`[${SKELETON_ATTR}]`).forEach(el => el.removeAttribute(SKELETON_ATTR));
        document.querySelectorAll(`[${DIVIDER_ATTR}]`).forEach(el => el.removeAttribute(DIVIDER_ATTR));
        document.querySelectorAll(`[${CLEARED_ATTR}]`).forEach(el => el.removeAttribute(CLEARED_ATTR));
        document.querySelectorAll(`[${ORPHAN_ATTR}]`).forEach(el => el.removeAttribute(ORPHAN_ATTR));
        styleEl?.remove();
        styleEl = null;
    }
});
