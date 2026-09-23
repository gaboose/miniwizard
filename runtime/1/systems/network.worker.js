// network.worker.js
//
// Runs the tailcat WASM netstack and all mesh/link/discovery logic in a
// dedicated worker, off the main thread. The page never touches a conn.
//
// Protocol with the page (network.js):
//   page -> worker:
//     {t:"join", room}
//     {t:"oc-create", id, h, m}     create/announce an owned channel
//     {t:"oc-send", id, m}          send on an owned channel
//     {t:"oc-close", id}            close an owned channel
//     {t:"shutdown"}                best-effort graceful close on pagehide
//   worker -> page:
//     {t:"ready"} | {t:"fail", msg}
//     {t:"oc", peerId, m}           remote owned-channel traffic (raw wire msg)
//     {t:"m", peerId, m}            application-level message
//     {t:"peer-disconnect", peerId}

const TAILCAT_BASE = "https://tailscale.github.io/tailcat/";
const DERP_MAP_URL = "https://tailcat.dev/derpmap.json";
const NTFY_BASE = "https://ntfy.sh/";
const MAX_DIAL_FAILS = 2;            // stop retrying addresses that look dead
const HEARTBEAT_MS = 500;          // per-link keepalive; silence is otherwise ambiguous
const PEER_TIMEOUT_MS = 1_000;      // no traffic for this long -> declare the peer dead
const HELLO_TIMEOUT_MS = 5_000;     // inbound conns must identify themselves or go
const TOPIC_PREFIX = "miniwizard";

const enc = new TextEncoder();

const me = {
    id: crypto.randomUUID().slice(0, 8),
};

// This is a classic (non-module) worker so we can pull in the Go shim
// synchronously; wasm_exec.js is not an ES module.
importScripts(TAILCAT_BASE + "wasm_exec.js");

// ---------- owned channels ----------
// An owned channel is created by exactly one peer. The worker keeps the
// authoritative {id, header, lastM} so newcomers can be brought up to
// date in registerLink; the page keeps the user-facing channel objects.
const ownedChannels = new Map();   // id -> {id, header, lastM}

// Remote channel bookkeeping and user callbacks live on the page; we just
// forward the wire messages.
function onOwnedChannel(peerId, m) { postMessage({ t: "oc", peerId, m }); }
function onMessage(peerId, m) { postMessage({ t: "m", peerId, m: m }); }
function onPeerDisconnect(peerId) { postMessage({ t: "peer-disconnect", peerId }); }

// ---------- wire helpers ----------
// Serialized writer per connection; drops messages if the peer backs up.
function makeWriter(conn) {
    let chain = Promise.resolve();
    let pending = 0;
    const w = {
        dead: false,
        send(obj) {
            if (w.dead || pending > 64) return;
            const bytes = enc.encode(JSON.stringify(obj) + "\n");
            pending++;
            chain = chain
                .then(() => conn.write(bytes))
                // A failed write means the link is broken; close the conn so
                // our read loop unblocks and runs the normal teardown.
                .catch(() => w.close())
                .finally(() => pending--);
        },
        close() { w.dead = true; try { conn.close(); } catch {} },
    };
    return w;
}

// Newline-delimited JSON reader.
async function readLines(conn, onMsg, onClose) {
    const dec = new TextDecoder();
    let buf = "";
    try {
        for (let chunk; (chunk = await conn.read()) !== null; ) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (!line.trim()) continue;
                try { onMsg(JSON.parse(line)); } catch {}
            }
        }
    } catch {}
    onClose();
}

// ---------- ntfy.sh discovery ----------
let topic = null;
let myAddr = null;

async function topicFor(room) {
    const h = await crypto.subtle.digest("SHA-256", enc.encode(TOPIC_PREFIX + ":" + room));
    return TOPIC_PREFIX + "-" + [...new Uint8Array(h)].slice(0, 12)
        .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function announce() {
    console.log("announce");
    await fetch(NTFY_BASE + topic, { method: "POST", body: JSON.stringify({ id: me.id, addr: myAddr }) });
}

// ---------- mesh links ----------
// One live link per peer id. Both ends of a link agree on its
// initiator (the dialer), so when a simultaneous-join race creates a
// duplicate pair, both sides keep the link with the smaller initiator
// id and close the other.
const links = new Map();     // peerId -> {w, initiatorId}
const dialing = new Set();   // peerIds with a dial in flight
const dialFails = new Map(); // addr -> failure count

function setupLink(conn, initiatorIdOrNull) {
    const w = makeWriter(conn);
    w.send({ t: "hi", id: me.id });
    let peerId = null;
    // A conn that never identifies itself (garbage dial, half-dead
    // tunnel) shouldn't sit around forever.
    setTimeout(() => { if (peerId === null) w.close(); }, HELLO_TIMEOUT_MS);
    readLines(conn, (m) => {
        if (m.t === "hi" && peerId === null && m.id && m.id !== me.id) {
            peerId = m.id;
            registerLink({ w, peerId, initiatorId: initiatorIdOrNull ?? peerId, last: performance.now() });
            return;
        }
        const l = peerId ? links.get(peerId) : null;
        if (!l || l.w !== w) return;
        l.last = performance.now(); // any traffic proves liveness, incl. {t:"hb"}
        switch (m.t) {
            case "m": onMessage(peerId, m); break;
            case "oc": onOwnedChannel(peerId, m); break;
        }
    }, () => {
        // Only tear down the peer if this link is the registered one; a
        // closed duplicate must not take the surviving link away.
        if (peerId && links.get(peerId)?.w === w) {
            links.delete(peerId);
            onPeerDisconnect(peerId);
        }
        w.close();
    });
}

function registerLink(link) {
    const currentLink = links.get(link.peerId);
    if (currentLink && currentLink.w !== link.w) {
        const keepCurrent = currentLink.initiatorId <= link.initiatorId;
        (keepCurrent ? link : currentLink).w.close();
        if (keepCurrent) return;
    }
    links.set(link.peerId, link);
    console.log("link set:", link.peerId, link.initiatorId);
    // Bring the newcomer up to date on every channel we own.
    for (const ch of ownedChannels.values()) link.w.send({ t: "oc", id: ch.id, h: ch.header, m: ch.lastM });
}

async function dialPeer(p) {
    if (links.has(p.id) || dialing.has(p.id)) return;
    if ((dialFails.get(p.addr) || 0) >= MAX_DIAL_FAILS) return;
    dialing.add(p.id);
    try {
        const conn = await tailcatDial({ addr: p.addr, derpMapURL: DERP_MAP_URL });
        setupLink(conn, me.id); // I dialed, so I'm the initiator
    } catch (e) {
        console.log("dial failed:", e);
        dialFails.set(p.addr, (dialFails.get(p.addr) || 0) + 1);
    } finally {
        dialing.delete(p.id);
    }
}

// Liveness. WireGuard has no session teardown and an abruptly killed
// peer never resets our TCP streams, so a hung read() is the default
// failure mode. So we do heartbeats. Closing our end of the conn unblocks
// our read loop, which runs the teardown.
setInterval(() => {
    const now = performance.now();
    const hb = { t: "hb" };
    for (const l of links.values()) {
        if (now - l.last > PEER_TIMEOUT_MS) l.w.close();
        else l.w.send(hb);
    }
}, HEARTBEAT_MS);

let closeListener = null;

// Best-effort graceful close so departures usually surface as EOF on the
// other side instead of a 20s heartbeat timeout. Triggered by the page's
// pagehide via a "shutdown" message; if the tab dies before we process
// it, the worker's sockets are torn down with it and peers fall back to
// the heartbeat timeout. Either way the page's unload path stays free.
function shutdown() {
    for (const l of links.values()) l.w.close();
    closeListener?.();
}

// Live presence: we don't poll for peers, we subscribe and announce.
// We're not even interested in the event log, just the pubsub
// functionality of ntfy.sh.
function subscribe() {
    const es = new EventSource(`${NTFY_BASE}${topic}/sse`);
    es.onmessage = (ev) => {
        try {
            const p = JSON.parse(JSON.parse(ev.data).message);
            if (!p.id || p.id === me.id || typeof p.addr !== "string" || !p.addr.startsWith("tc")) return;
            dialPeer(p);
        } catch {}
    };
    // EventSource reconnects on its own; after every (re)open, announce
    // so that peers we missed while we were away know to connect to us.
    es.onopen = async () => {
        try { announce(); } catch {}
    };
}

async function joinRoom(room) {
    topic = await topicFor(room);

    const ln = await tailcatListen({
        derpMapURL: DERP_MAP_URL,
        onConnection(conn) { setupLink(conn, null); }, // they dialed; initiator = their id from hi
    });
    myAddr = ln.addr;
    closeListener = ln.close;

    subscribe();
}

async function fetchWasm() {
    const gz = await fetch(TAILCAT_BASE + "main.wasm.gz");
    if (gz.ok) {
        let loaded = 0;
        const counted = gz.body.pipeThrough(new TransformStream({
            transform(chunk, ctl) {
                loaded += chunk.byteLength;
                ctl.enqueue(chunk);
            },
        })).pipeThrough(new DecompressionStream("gzip"));
        return new Response(counted, { headers: { "Content-Type": "application/wasm" } });
    }
    const resp = await fetch(TAILCAT_BASE + "main.wasm");
    if (!resp.ok) throw new Error(`fetching main.wasm: ${resp.status}`);
    return new Response(resp.body, { headers: { "Content-Type": "application/wasm" } });
}

function fail(msg) {
    console.log(msg);
    postMessage({ t: "fail", msg });
}

async function boot(room) {
    try {
        const ready = new Promise((res) => { globalThis.onTailcatReady = res; });
        const go = new Go();
        const { instance } = await WebAssembly.instantiateStreaming(fetchWasm(), go.importObject);
        go.run(instance);
        await ready;
        try {
            await joinRoom(room);
            postMessage({ t: "ready" });
        } catch (e) {
            fail("Join failed: " + e.message);
        }
    } catch (e) {
        fail("WebAssembly load failed: " + e.message);
    }
}

onmessage = (ev) => {
    const msg = ev.data;
    switch (msg.t) {
        case "join":
            boot(msg.room);
            break;
        case "oc-create": {
            ownedChannels.set(msg.id, { id: msg.id, header: msg.h, lastM: msg.m });
            for (const l of links.values()) l.w.send({ t: "oc", id: msg.id, h: msg.h, m: msg.m });
            break;
        }
        case "oc-send": {
            const ch = ownedChannels.get(msg.id);
            if (!ch) break;
            ch.lastM = msg.m;
            for (const l of links.values()) l.w.send({ t: "oc", id: msg.id, m: msg.m });
            break;
        }
        case "oc-close": {
            if (!ownedChannels.delete(msg.id)) break;
            for (const l of links.values()) l.w.send({ t: "oc", id: msg.id, close: true });
            break;
        }
        case "shutdown":
            shutdown();
            break;
    }
};