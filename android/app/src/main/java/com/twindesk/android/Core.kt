// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Everything the phone does, in one place: discovery, the link and the features on it. The
// foreground service (TwinService) keeps it alive; the UI reads it and bumps on `version`.
//
// When to connect: only when asked — the Mac's phone tile (an invite from a paired computer),
// Connect here, or Pair — and to resume a session that dropped by accident (for
// PHONE_GRACE_MS, while the Mac keeps the session for us). Never on our own otherwise, since
// connecting takes the Mac away from the computer it is paired with.
package com.twindesk.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

abstract class Feature(val core: Core) {
    open fun onWelcome(host: Host) {}
    open fun onClosed() {}
    // Return true when the message was this feature's.
    open fun onMessage(t: String, m: JSONObject): Boolean = false
}

class Core private constructor(val ctx: Context) : Link.Events {
    val store = Store(ctx)
    val version = MutableStateFlow(0)
    val bg = Executors.newScheduledThreadPool(2) { r -> Thread(r, "td-core").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())

    val discovery = Discovery(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName) }, ::changed, ::onInvite)
    val link = Link(store, this)

    // An unpaired computer asked us to pair (shown until acted on).
    @Volatile var invite: Found? = null; private set
    // Resume: until when we try to get a dropped session back.
    @Volatile private var resumeUntil = 0L
    @Volatile private var resumeHost: Host? = null

    val sync = PairSync(this)
    val clip = Clip(this)
    val notifs = Notifs(this)
    val files = Files(this)
    val fclip = FileClip(this)
    val info = PhoneInfo(this)
    val apps = Apps(this)
    val wake = Wake(this)
    val adb = Adb(this)
    val pointer = Pointer(this)
    val drive = Drive(this)
    val screen = Screen(this)
    val macSound = MacSound(this)
    val shortcuts = Shortcuts(this)
    val kvm = Kvm(this)
    val updates = Updates(this)
    private val features: List<Feature> = listOf(sync, clip, notifs, files, fclip, info, apps, wake, adb, pointer, drive, screen, macSound, shortcuts, kvm)

    val host: Host? get() = if (link.connected) link.host else null

    fun start() {
        discovery.start()
        Notify.channels(ctx)
        updates.start()
    }

    // Wi-Fi out of power save while a screen streams either way (power save adds 50–200 ms bursts).
    private val wifiFast by lazy { WifiFast(ctx) }

    fun changed() {
        // (runCatching: discovery may report before every feature exists)
        runCatching { wifiFast.hold(link.connected && !link.wired && (screen.viewing || adb.viewed)) }
        version.value++
        main.post { TwinService.refresh(ctx) }
    }

    fun send(m: JSONObject): Boolean = link.send(m)

    fun hosts(): List<Host> = store.hosts()

    // The UI's Connect, or the Mac's invite: take the session.
    fun connect(h: Host) {
        resumeUntil = 0
        // The Mac's screen, input and sound need wireless debugging: switch it on as we connect.
        if (adb.canEnable && !adb.wifiDebugging) adb.enable(true)
        val seen = discovery.found[h.id]
        if (seen != null && (seen.address != h.address || seen.port != h.port)) {
            h.address = seen.address
            h.port = seen.port
            store.putHost(h)
        }
        link.connect(h)
    }

    // The computer found this device on a USB cable (adb reverse to its port, then a broadcast:
    // WiredReceiver): take the session through the cable, also from a Wi-Fi session with it.
    fun connectWired(id: String, port: Int, nonce: String) {
        val h = store.hosts().find { it.id == id }
        if (h == null) { Log.i("TwinDesk", "USB: $id isn't paired here"); return }
        Log.i("TwinDesk", "USB: connecting to ${h.name} through the cable")
        resumeUntil = 0
        wiredNonce = nonce
        link.connect(h, port)
    }
    @Volatile private var wiredNonce = ""

    fun disconnect() {
        resumeUntil = 0
        link.disconnect()
    }

    fun pair(f: Found) {
        invite = null
        discovery.clearInvite(f.id)
        link.startPairing(f.address, f.port, f.name)
    }

    fun pairAddress(address: String) = link.startPairing(address.trim(), Proto.PORT, address.trim())

    fun dismissInvite() {
        invite?.let { discovery.clearInvite(it.id) }
        invite = null
        changed()
    }

    fun forget(id: String) {
        if (link.host?.id == id) link.disconnect()
        store.forgetHost(id)
        changed()
    }

    private fun onInvite(f: Found) {
        val h = store.hosts().find { it.id == f.id }
        if (h != null) {
            Log.i("TwinDesk", "invite from ${f.name}: connecting")
            if (link.host?.id == h.id && (link.state == "connected" || link.state == "connecting")) return
            h.address = f.address
            h.port = f.port
            connect(h)
            return
        }
        if (link.pair != null) return
        invite = f
        Notify.invite(ctx, f.name)
        changed()
    }

    // ---- Link.Events ----

    override fun onChange() = changed()

    override fun onWelcome(host: Host) {
        Log.i("TwinDesk", "session with ${host.name}")
        resumeUntil = 0
        Notify.cancelInvite(ctx)
        // Tells the computer which of its USB devices this is (its screen and input use that one).
        if (link.wired) link.send(JSONObject().put("t", "phone.wired").put("nonce", wiredNonce))
        for (f in features) runCatching { f.onWelcome(host) }.onFailure { Log.e("TwinDesk", "welcome", it) }
        changed()
    }

    override fun onMessage(m: JSONObject) {
        val t = m.optString("t")
        main.post {
            for (f in features) {
                val mine = try { f.onMessage(t, m) } catch (e: Exception) { Log.e("TwinDesk", "message $t", e); true }
                if (mine) return@post
            }
        }
    }

    override fun onClosed(host: Host, code: String?) {
        main.post {
            for (f in features) runCatching { f.onClosed() }
            changed()
        }
        // Dropped by accident (not let go, replaced, forgotten or closed here): try to get it back.
        val accidental = code == null || code !in setOf("local", Proto.E.RELEASED, Proto.E.REPLACED, Proto.E.BAD_TOKEN, Proto.E.BUSY)
        if (!accidental || link.state == "failed") return
        if (resumeUntil == 0L) resumeUntil = System.currentTimeMillis() + Proto.PHONE_GRACE_MS
        resumeHost = host
        bg.schedule({ resume() }, 1500, TimeUnit.MILLISECONDS)
    }

    private fun resume() {
        val h = resumeHost ?: return
        if (System.currentTimeMillis() > resumeUntil || link.connected || link.state == "connecting" || link.pair != null) return
        Log.i("TwinDesk", "resuming the session with ${h.name}")
        val until = resumeUntil
        connect(store.hosts().find { it.id == h.id } ?: return)
        resumeUntil = until // connect() clears it; keep the window open for the next drop
    }

    companion object {
        @Volatile private var instance: Core? = null
        fun get(ctx: Context): Core = instance ?: synchronized(this) {
            instance ?: Core(ctx.applicationContext).also { instance = it; it.start() }
        }
    }
}
