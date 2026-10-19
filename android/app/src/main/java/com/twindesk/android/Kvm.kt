// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's mouse and keyboard on this device, as the Mac shares them (its Kvm drives us through
// wireless debugging): where the Mac is (kvm.layout), cursor sharing on/off (kvm.link, the same
// switch as the hotkey's double-tap), and the Mac's hotkey (phone.mac). The rest of the Cursor and
// Keyboard pages are pair.sync switches and values (PairSync).
package com.twindesk.android

import org.json.JSONObject

class Kvm(core: Core) : Feature(core) {
    // Where the Mac is from here: left | right | top | bottom.
    val macSide: String get() = core.store.prefsString("kvm.macSide", "right")
    @Volatile var linked = true; private set
    @Volatile var hotkey = "Right Option"; private set

    private val opposite = mapOf("left" to "right", "right" to "left", "top" to "bottom", "bottom" to "top")

    // kvm.layout {pcSide}: where the other side is, from the sender. Ours is the opposite of theirs.
    fun setMacSide(side: String) {
        if (side !in opposite) return
        core.store.setPrefsString("kvm.macSide", side)
        core.send(msg("kvm.layout", "pcSide" to side))
        core.changed()
    }

    fun setLinked(on: Boolean) {
        linked = on
        core.send(msg("kvm.link", "on" to on))
        core.changed()
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            "kvm.layout" -> opposite[m.optString("pcSide")]?.let { core.store.setPrefsString("kvm.macSide", it) }
            "kvm.link" -> linked = m.optBoolean("on", true)
            "phone.mac" -> hotkey = m.optString("hotkey").ifEmpty { hotkey }
            "kvm.take", "kvm.release", "k.mm", "k.md", "k.mu", "k.wh", "k.kd", "k.ku", "k.ge" -> Unit // the Mac injects through adb
            else -> return false
        }
        core.changed()
        return true
    }
}
