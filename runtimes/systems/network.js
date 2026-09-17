export async function createNetworkSystem(roomName, { onNewOwnedChannel } = {}) {
    const TAILCAT_BASE = "https://tailscale.github.io/tailcat/";
    const DERP_MAP_URL = "https://tailcat.dev/derpmap.json";
    const NTFY_BASE = "https://ntfy.sh/";
    const MAX_DIAL_FAILS = 2;            // stop retrying addresses that look dead
    const HEARTBEAT_MS = 5_000;          // per-link keepalive; silence is otherwise ambiguous
    const PEER_TIMEOUT_MS = 20_000;      // no traffic for this long -> declare the peer dead
    const HELLO_TIMEOUT_MS = 30_000;     // inbound conns must identify themselves or go
    const TOPIC_PREFIX = "miniwizard";

    const enc = new TextEncoder();

    const me = {
        id: crypto.randomUUID().slice(0, 8),
    };

    // ---------- owned channels ----------
    // An owned channel is created by exactly one peer. Every other peer
    // learns about it via {t:"oc", ...}.
    const ownedChannels = new Map();   // id -> {id, header, lastM}
    const remoteChannels = new Map();  // peerId -> Map(id -> remote channel)

    function onOwnedChannel(peerId, m) {
        if (typeof m.id !== "string") return;
        let byId = remoteChannels.get(peerId);

        if (m.close) {
            // Channel closing.
            const ch = byId?.get(m.id);
            if (!ch) return;
            byId.delete(m.id);
            ch.onClose?.();
            return
        }

        if (!byId) remoteChannels.set(peerId, byId = new Map());
        let ch = byId.get(m.id);
        if (!ch) {
            // First message -> create channel.
            ch = {
                id: m.id,
                header: m.h,
                lastMessage: m.m,
                onMessage: null,
                onClose: null,
            };
            byId.set(m.id, ch);
            onNewOwnedChannel?.(ch);
            return
        }

        // Receiving a message on an existing channel.
        ch.lastMessage = m.m;
        if (m.m !== undefined) ch.onMessage?.(m.m);
    }

    function onMessage(peerId, m) {
        console.log("application level message:", peerId, m)
    }

    function onPeerDisconnect(peerId) {
        console.log("peer disconnected:", peerId)
        const byId = remoteChannels.get(peerId);
        remoteChannels.delete(peerId);
        if (byId) for (const ch of byId.values()) ch.onClose?.();
    }

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
        w.send({t: "hi", id: me.id});
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
                onPeerDisconnect(peerId)
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
        console.log("link set:", link.peerId, link.initiatorId)
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
        } catch {
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

    // Best-effort graceful close so departures usually surface as EOF on
    // the other side instead of a 20s heartbeat timeout.
    let closeListener = null;
    addEventListener("pagehide", async () => {
        for (const l of links.values()) l.w.close();
        closeListener?.();
    });

    // Live presence: we don't poll for peers, we subscribe and announce.
    // We're not even interested in the event log, just the pubsub
    // functionality of ntfy.sh.
    function subscribe() {
        const es = new EventSource(`${NTFY_BASE}${topic}/sse`);
        es.onmessage = (ev) => {
            try {
                const p = JSON.parse(JSON.parse(ev.data).message);
                if (!p.id || p.id === me.id || typeof p.addr !== "string" || !p.addr.startsWith("tc")) return;
                dialPeer(p)
            } catch {}
        };
        // EventSource reconnects on its own; after every (re)open, announce
        // so that peers we missed while we were away know to connect to us.
        es.onopen = async () => {
            try { announce() } catch {}
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

    function loadScript(src) {
        return new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = res;
            s.onerror = () => rej(new Error("failed to load " + src));
            document.head.append(s);
        });
    }

    await loadScript(TAILCAT_BASE + "wasm_exec.js");

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

    function fail(msg) { console.log(msg) }

    try {
        const ready = new Promise((res) => { globalThis.onTailcatReady = res; });
        const go = new Go();
        const { instance } = await WebAssembly.instantiateStreaming(fetchWasm(), go.importObject);
        go.run(instance);
        await ready;
        try {
            await joinRoom(roomName);
        } catch (e) {
            fail("Join failed: " + e.message);
        }
    } catch (e) {
        fail("WebAssembly load failed: " + e.message);
    }

    return {
        ownedChannel({id, header, m}) {
            const ch = {
                id,
                header,
                lastMessage: m,
                send(m) {
                    ch.lastMessage = m
                    for (const l of links.values()) l.w.send({t: "oc", id, m});
                },
                close() {
                    if (ownedChannels.get(id) !== ch) return;
                    ownedChannels.delete(id);
                    for (const l of links.values()) l.w.send({t: "oc", id, close: true});
                }
            };
            ownedChannels.set(id, ch);
            for (const l of links.values()) l.w.send({ t: "oc", id, h: header, m });
            return ch
        },
        sharedChannel({id, onMessage, m}) {
            // var lastMessage = m
            // for (const l of links.values()) l.w.send({t: "sc", id, m});
            // return {
            //     send(m) {
            //         lastMessage = m
            //         for (const l of links.values()) l.w.send({t: "sc", id, m});
            //     }
            // }
        }
    }
}