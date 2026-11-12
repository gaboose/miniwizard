import { joinRoom } from "trystero"

const APP_ID = "gaboose.miniwizard"

export function createNetworkSystem(roomName, { onNewOwnedChannel } = {}) {
    const room = joinRoom({ appId: APP_ID }, roomName)

    const remoteChannels = new Map() // peerId -> Map(id -> channel)
    const myChannels = new Map()     // id -> channel

    const control = room.makeAction("control")

    function addRemote(peerId, id, m) {
        let byId = remoteChannels.get(peerId)
        if (!byId) remoteChannels.set(peerId, byId = new Map())
        if (byId.has(id)) return
        const action = room.makeAction(`ch ${id}`)
        const ch = { peerId, id, lastMessage: m, onMessage: null, onClose: null }
        action.onMessage = (msg, { peerId: from }) => {
            if (from !== peerId) return
            ch.lastMessage = msg
            ch.onMessage?.(msg)
        }
        byId.set(id, ch)
        onNewOwnedChannel?.(ch)
    }

    room.onPeerJoin = (peerId) => {
        console.log(`Peer joined: ${peerId}`)
        for (const ch of myChannels.values()) {
            control.send({ t: "ch", id: ch.id, m: ch.lastMessage }, { target: peerId })
        }
    }

    room.onPeerLeave = (peerId) => {
        const byId = remoteChannels.get(peerId)
        remoteChannels.delete(peerId)
        if (byId) for (const ch of byId.values()) ch.onClose?.()
        console.log(`Peer left: ${peerId}`)
    }

    control.onMessage = (data, { peerId }) => {
        if (data.t === "ch") addRemote(peerId, data.id, data.m)
    }

    return {
        update() { },
        ownedChannel({ id, m }) {
            const action = room.makeAction(`ch ${id}`)
            const ch = {
                id,
                lastMessage: m,
                send(m) {
                    ch.lastMessage = m
                    action.send(m)
                },
            }
            myChannels.set(id, ch)
            control.send({ t: "ch", id, m })
            return ch
        },
    }
}
