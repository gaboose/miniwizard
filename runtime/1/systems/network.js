export function createNetworkSystem(roomName, { onNewOwnedChannel } = {}) {
    // Classic worker (not a module): the worker pulls in Go's wasm_exec.js
    // via importScripts, which module workers can't do.
    const worker = new Worker(new URL("./network.worker.js", import.meta.url));
 
    // ---------- owned channels (page-side handles) ----------
    // The worker holds the authoritative {id, header, lastMessage} so it can
    // sync newcomers itself; these are just the objects handed to the app.
    const ownedChannels = new Map();   // id -> channel handle
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
            return;
        }
 
        if (!byId) remoteChannels.set(peerId, byId = new Map());
        let ch = byId.get(m.id);
        if (!ch) {
            // First message -> create channel.
            ch = {
                peerId,
                id: m.id,
                header: m.h,
                lastMessage: m.m,
                onMessage: null,
                onClose: null,
            };
            console.log("new chan", ch, m);
            byId.set(m.id, ch);
            onNewOwnedChannel?.(ch);
            return;
        }
 
        // Receiving a message on an existing channel.
        ch.lastMessage = m.m;
        if (m.m !== undefined) ch.onMessage?.(m.m);
    }
 
    function onMessage(peerId, m) {
        console.log("application level message:", peerId, m);
    }
 
    function onPeerDisconnect(peerId) {
        console.log("peer disconnected:", peerId);
        const byId = remoteChannels.get(peerId);
        remoteChannels.delete(peerId);
        if (byId) for (const ch of byId.values()) ch.onClose?.();
    }
 
    // ---------- worker wiring ----------
    let readyResolve;
    const ready = new Promise((res) => { readyResolve = res; });
 
    worker.onmessage = (ev) => {
        const msg = ev.data;
        switch (msg.t) {
            case "ready": readyResolve(); break;
            case "fail": readyResolve(); break; // already logged in the worker; keep old behavior of returning the API anyway
            case "oc": onOwnedChannel(msg.peerId, msg.m); break;
            case "m": onMessage(msg.peerId, msg.m); break;
            case "peer-disconnect": onPeerDisconnect(msg.peerId); break;
        }
    };
 
    addEventListener("pagehide", () => {
        try { worker.postMessage({ t: "shutdown" }); } catch {}
    });
 
    worker.postMessage({ t: "join", room: roomName });
 
    return {
        // Resolves once the netstack is up and the room is joined (or the
        // worker reported failure). Awaiting it is optional: ownedChannel /
        // send work immediately, because the worker records channel state
        // right away and broadcasts it to peers once links come up.
        ready,
        update() {
            
        },
        ownedChannel({ id, header, m }) {
            console.log("creating owned channel:", id, header, m);
            const ch = {
                id,
                header,
                lastMessage: m,
                send(m) {
                    ch.lastMessage = m;
                    worker.postMessage({ t: "oc-send", id, m });
                },
                close() {
                    if (ownedChannels.get(id) !== ch) return;
                    ownedChannels.delete(id);
                    worker.postMessage({ t: "oc-close", id });
                },
            };
            ownedChannels.set(id, ch);
            worker.postMessage({ t: "oc-create", id, h: header, m });
            return ch;
        },
        sharedChannel({ id, onMessage, m }) {
            // var lastMessage = m
            // for (const l of links.values()) l.w.send({t: "sc", id, m});
            // return {
            //     send(m) {
            //         lastMessage = m
            //         for (const l of links.values()) l.w.send({t: "sc", id, m});
            //     }
            // }
        },
    };
}

export function createRemoteCharacterEntity(ch, createCharComponent) {
    const state = {
        pos: { x: ch.lastMessage.x, y: ch.lastMessage.y },
        vel: { x: 0, y: 0 },
        facing: "right",
        hitbox: { x: -5, y: -3, w: 10, h: 6 },
    };

    const char = createCharComponent(state)
    ch.onMessage = (m) => {
        state.vel.x = m.x - state.pos.x;
        state.vel.y = m.y - state.pos.y;
        if (state.vel.x > 0) state.facing = "right";
        else if (state.vel.x < 0) state.facing = "left";
        state.pos.x = m.x;
        state.pos.y = m.y;
    };
    ch.onClose = () => {
        char.destroy();
        console.log("ch.onClose:", ch.id);
    };

    return {}
}