// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer asks the phone to wake (a phone notification clicked there opens its app in a
// window, which a locked phone fills with its lock screen). The screen comes on and the phone asks
// for its own unlock (PIN, pattern, fingerprint: only ever typed on the phone); `phone.awake` says
// when it's unlocked. Through the app, not adb: MIUI drops wireless debugging while locked.
package com.twindesk.android

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.os.PowerManager
import org.json.JSONObject

class Wake(core: Core) : Feature(core) {
    @Volatile private var waiting = false
    private val pm get() = core.ctx.getSystemService(PowerManager::class.java)
    private val km get() = core.ctx.getSystemService(KeyguardManager::class.java)
    val unlocked get() = pm.isInteractive && !km.isKeyguardLocked

    init {
        // Unlocked some other way (the prompt cancelled, then a fingerprint): still an answer.
        core.ctx.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { if (waiting) answer() }
        }, IntentFilter(Intent.ACTION_USER_PRESENT))
    }

    override fun onClosed() { waiting = false }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.PHONE_WAKE) return false
        if (unlocked) { waiting = true; answer(); return true }
        waiting = true
        core.send(msg(Proto.T.PHONE_AWAKE, "unlocked" to false, "waiting" to true))
        // Starting it from the background is allowed: the computer granted "display over other apps".
        runCatching {
            core.ctx.startActivity(Intent(core.ctx, WakeActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))
        }
        return true
    }

    fun answer() {
        if (!waiting) return
        waiting = false
        core.send(msg(Proto.T.PHONE_AWAKE, "unlocked" to true))
    }
}

// Invisible: turns the screen on over the lock screen (manifest) and brings up the unlock prompt
// (or just dismisses a swipe-only lock screen).
class WakeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = Core.get(this)
        val km = getSystemService(KeyguardManager::class.java)
        if (!km.isKeyguardLocked) { core.wake.answer(); finish(); return }
        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { core.wake.answer(); finish() }
            override fun onDismissCancelled() = finish()
            override fun onDismissError() = finish()
        })
    }
}
