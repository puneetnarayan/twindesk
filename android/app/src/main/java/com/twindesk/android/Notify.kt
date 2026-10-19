// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every notification TwinDesk posts: the link (the foreground service), invites, files arriving,
// files copied on the computer (Copy / Save), and the computer's own notifications.
package com.twindesk.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

object Notify {
    const val CH_LINK = "link"
    const val CH_INVITE = "invite"
    const val CH_FILES = "files"
    const val CH_CLIP = "clip"
    const val CH_COMPUTER = "computer"
    const val CH_UPDATES = "updates"
    const val CH_SCREEN = "screen"

    const val ID_LINK = 1
    const val ID_INVITE = 2
    const val ID_FCLIP = 3
    const val ID_ADB = 4
    const val ID_PAIR = 5
    const val ID_UPDATE = 6
    const val ID_SCREEN = 7
    private const val ID_FILES_BASE = 1000
    private const val ID_COMPUTER_BASE = 100000

    private fun nm(ctx: Context) = ctx.getSystemService(NotificationManager::class.java)

    fun channels(ctx: Context) {
        val n = nm(ctx)
        n.createNotificationChannel(NotificationChannel(CH_LINK, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while TwinDesk is ready for your computer"
            setShowBadge(false)
        })
        n.createNotificationChannel(NotificationChannel(CH_INVITE, "Pairing requests", NotificationManager.IMPORTANCE_HIGH))
        n.createNotificationChannel(NotificationChannel(CH_FILES, "Files", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Files arriving from your computer"
        })
        n.createNotificationChannel(NotificationChannel(CH_CLIP, "Copied on your computer", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Files copied with the shortcut, ready to copy or save here"
        })
        n.createNotificationChannel(NotificationChannel(CH_COMPUTER, "Your computer’s notifications", NotificationManager.IMPORTANCE_HIGH))
        n.createNotificationChannel(NotificationChannel(CH_SCREEN, "Shared screens", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Your computer started sharing its screen with this phone"
        })
        n.createNotificationChannel(NotificationChannel(CH_UPDATES, "Updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A new version of TwinDesk on GitHub"
        })
    }

    fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun action(ctx: Context, action: String, req: Int, extra: String = ""): PendingIntent = PendingIntent.getBroadcast(
        ctx, req, Intent(ctx, ActionReceiver::class.java).setAction(action).putExtra("arg", extra),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // The computer started sharing and the viewer couldn't open by itself (no "Display over other
    // apps"): tap to see it.
    fun screen(ctx: Context, name: String) {
        val open = PendingIntent.getActivity(
            ctx, 7, Intent(ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        runCatching {
            nm(ctx).notify(ID_SCREEN, Notification.Builder(ctx, CH_SCREEN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("$name is sharing its screen")
                .setContentText("Tap to see it here")
                .setContentIntent(open)
                .setAutoCancel(true)
                .build())
        }
    }

    fun cancelScreen(ctx: Context) = runCatching { nm(ctx).cancel(ID_SCREEN) }.let { }

    fun link(ctx: Context, core: Core): Notification {
        val h = core.host
        val b = Notification.Builder(ctx, CH_LINK)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentIntent(openApp(ctx))
            .setOngoing(true)
            .setShowWhen(false)
        when {
            h != null -> {
                b.setContentTitle("Connected to ${h.name}")
                b.setContentText(core.files.activeLine() ?: "Files, clipboard and notifications are shared")
                // Three buttons at most: wireless debugging being off has its own notification (adbOff).
                b.addAction(Notification.Action.Builder(null, "Send clipboard", action(ctx, ActionReceiver.SEND_CLIP, 11)).build())
                b.addAction(Notification.Action.Builder(null, "Disconnect", action(ctx, ActionReceiver.DISCONNECT, 12)).build())
            }
            core.link.state == "connecting" -> b.setContentTitle("Connecting to ${core.link.host?.name ?: "your computer"}…")
            else -> {
                b.setContentTitle("Ready for your computer")
                val near = core.hosts().firstOrNull { core.discovery.found.containsKey(it.id) }
                b.setContentText(if (near != null) "${near.name} is nearby" else "Open TwinDesk on your Mac to connect")
                if (near != null) b.addAction(Notification.Action.Builder(null, "Connect to ${near.name}", action(ctx, ActionReceiver.CONNECT, 13, near.id)).build())
            }
        }
        b.addAction(Notification.Action.Builder(null, "Exit", action(ctx, ActionReceiver.EXIT, 15)).build())
        return b.build()
    }

    fun invite(ctx: Context, name: String) {
        nm(ctx).notify(
            ID_INVITE,
            Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("$name wants to pair")
                .setContentText("Open TwinDesk to compare the code")
                .setContentIntent(openApp(ctx))
                .setAutoCancel(true)
                .build(),
        )
    }

    fun cancelInvite(ctx: Context) = nm(ctx).cancel(ID_INVITE)

    // A new release on GitHub (Updates): tap to download it in the browser.
    fun update(ctx: Context, latest: String, current: String) {
        val open = PendingIntent.getActivity(
            ctx, 50, Intent(Intent.ACTION_VIEW, Uri.parse(Core.get(ctx).updates.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm(ctx).notify(
            ID_UPDATE,
            Notification.Builder(ctx, CH_UPDATES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("TwinDesk $latest is available")
                .setContentText("You have $current. Tap to download the new version.")
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }

    // Wireless debugging went off while connected (MIUI / HyperOS do that): tap to turn it on.
    fun adbOff(ctx: Context, computer: String) {
        val open = PendingIntent.getActivity(
            ctx, 30, Intent(ctx, AdbActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm(ctx).notify(
            ID_ADB,
            Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Wireless debugging is off")
                .setContentText("$computer needs it for this screen, its mouse and keyboard here, and sound. Tap, then turn on USB debugging and Wireless debugging (both).")
                .setStyle(Notification.BigTextStyle().bigText("$computer needs it for this screen, its mouse and keyboard here, and sound. Tap, then turn on USB debugging and Wireless debugging (both)."))
                .setContentIntent(open)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .build(),
        )
    }

    fun cancelAdbOff(ctx: Context) = nm(ctx).cancel(ID_ADB)

    // The pairing code box: type the code from "Pair device with pairing code" right here, so
    // Settings' dialog stays open (it closes when you switch apps).
    fun pairCode(ctx: Context, computer: String) {
        val input = android.app.RemoteInput.Builder("code").setLabel("6-digit pairing code").build()
        val pi = PendingIntent.getBroadcast(
            ctx, 40, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.PAIR_CODE),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm(ctx).notify(
            ID_PAIR,
            Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Type the pairing code here")
                .setContentText("Settings shows a 6-digit code. Type it here to pair with $computer.")
                .setStyle(Notification.BigTextStyle().bigText("Settings shows a 6-digit code under “Pair with device”. Tap Enter code, type it, and send. $computer does the rest."))
                .setOnlyAlertOnce(false)
                .addAction(Notification.Action.Builder(null, "Enter code", pi).addRemoteInput(input).build())
                .build(),
        )
    }

    fun pairResult(ctx: Context, title: String, text: String, again: Boolean, progress: Boolean = false) {
        val b = Notification.Builder(ctx, CH_INVITE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setAutoCancel(!progress)
        if (progress) b.setProgress(0, 0, true).setOngoing(true)
        if (again) {
            val input = android.app.RemoteInput.Builder("code").setLabel("6-digit pairing code").build()
            val pi = PendingIntent.getBroadcast(
                ctx, 40, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.PAIR_CODE),
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            b.addAction(Notification.Action.Builder(null, "Enter code", pi).addRemoteInput(input).build())
        }
        nm(ctx).notify(ID_PAIR, b.build())
    }

    // Files on their way (progress) and when they are here (open / show).
    fun files(ctx: Context, key: Int, title: String, text: String, progress: Int?, open: Intent?) {
        val b = Notification.Builder(ctx, CH_FILES)
            .setSmallIcon(if (progress != null) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(progress != null)
            .setAutoCancel(progress == null)
        if (progress != null) b.setProgress(100, progress, progress < 0)
        if (open != null) b.setContentIntent(PendingIntent.getActivity(ctx, key, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        nm(ctx).notify(ID_FILES_BASE + key, b.build())
    }

    fun cancelFiles(ctx: Context, key: Int) = nm(ctx).cancel(ID_FILES_BASE + key)

    // The computer copied files with its shortcut: copy them here, or save them.
    fun fclipOffer(ctx: Context, from: String, what: String, id: String) {
        nm(ctx).notify(
            ID_FCLIP,
            Notification.Builder(ctx, CH_CLIP)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Copied on $from")
                .setContentText(what)
                .setContentIntent(openApp(ctx))
                .setTimeoutAfter(10 * 60 * 1000L)
                .addAction(Notification.Action.Builder(null, "Copy to clipboard", action(ctx, ActionReceiver.FCLIP_COPY, 21, id)).build())
                .addAction(Notification.Action.Builder(null, "Save to Downloads", action(ctx, ActionReceiver.FCLIP_SAVE, 22, id)).build())
                .build(),
        )
    }

    // Files are on the clipboard: paste them anywhere, or share them.
    fun fclipReady(ctx: Context, title: String, text: String, share: Intent?) {
        val b = Notification.Builder(ctx, CH_CLIP)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(5 * 60 * 1000L)
            .setAutoCancel(true)
        if (share != null) {
            val pi = PendingIntent.getActivity(ctx, 23, Intent.createChooser(share, "Share").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            b.addAction(Notification.Action.Builder(null, "Share…", pi).build())
            b.setContentIntent(pi)
        }
        nm(ctx).notify(ID_FCLIP, b.build())
    }

    fun fclipProgress(ctx: Context, title: String, progress: Int) {
        nm(ctx).notify(
            ID_FCLIP,
            Notification.Builder(ctx, CH_CLIP)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setProgress(100, progress, progress < 0)
                .build(),
        )
    }

    fun cancelFclip(ctx: Context) = nm(ctx).cancel(ID_FCLIP)

    fun fromComputer(ctx: Context, key: String, app: String, title: String, body: String, computer: String) {
        nm(ctx).notify(
            ID_COMPUTER_BASE + (key.hashCode() and 0xffff),
            Notification.Builder(ctx, CH_COMPUTER)
                .setSmallIcon(R.drawable.ic_stat)
                .setSubText("$app · $computer")
                .setContentTitle(title.ifEmpty { app })
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .build(),
        )
    }

    fun viewIntent(uri: Uri, mime: String?): Intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime ?: "*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
}
