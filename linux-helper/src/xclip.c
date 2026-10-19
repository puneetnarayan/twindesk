// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// `clipFiles`: the files on the clipboard (linux/fclip.js), read as an X client. A Wayland desktop
// only shows the clipboard to the app in front, but it mirrors it to XWayland, where any client
// may ask: so this works in both sessions while TwinDesk is in the background. Its own X
// connection, opened when first asked (on Wayland that starts XWayland if it isn't running). Asks
// for GNOME's x-special/gnome-copied-files, then text/uri-list; replies {"text": "…"} (the
// helper's loop waits for the owner at most half a second per format).
#include "helper.h"
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xatom.h>

static Display *dpy;
static Window win;

static char *ask(const char *target) {
  Atom clip = XInternAtom(dpy, "CLIPBOARD", False), t = XInternAtom(dpy, target, False), prop = XInternAtom(dpy, "TWINDESK_CLIP", False);
  XDeleteProperty(dpy, win, prop);
  XConvertSelection(dpy, clip, t, prop, win, CurrentTime);
  XFlush(dpy);
  double until = now_ms() + 500;
  for (;;) {
    while (XPending(dpy)) {
      XEvent e;
      XNextEvent(dpy, &e);
      if (e.type != SelectionNotify || e.xselection.requestor != win) continue;
      if (e.xselection.property == None) return NULL; // no owner, or not in that format
      Atom type;
      int fmt;
      unsigned long n = 0, after;
      unsigned char *data = NULL;
      if (XGetWindowProperty(dpy, win, prop, 0, 1 << 20, True, AnyPropertyType, &type, &fmt, &n, &after, &data) != Success || !data) return NULL;
      char *s = NULL;
      if (fmt == 8 && type != XInternAtom(dpy, "INCR", False)) { // INCR: a list too long to take
        s = malloc(n + 1);
        memcpy(s, data, n);
        s[n] = 0;
      }
      XFree(data);
      return s;
    }
    double left = until - now_ms();
    if (left <= 0) return NULL;
    struct pollfd p = { ConnectionNumber(dpy), POLLIN, 0 };
    poll(&p, 1, (int)left + 1);
  }
}

void xclip_files(double id) {
  if (!dpy && (dpy = XOpenDisplay(NULL))) {
    win = XCreateSimpleWindow(dpy, DefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0);
  }
  char *text = NULL;
  if (dpy) {
    text = ask("x-special/gnome-copied-files");
    if (!text) text = ask("text/uri-list");
  }
  size_t cap = (text ? strlen(text) * 6 : 0) + 96, len;
  char *out = malloc(cap);
  len = (size_t)snprintf(out, cap, "{\"id\":%.0f,\"ok\":%s,\"text\":\"", id, dpy ? "true" : "false");
  for (const unsigned char *p = (const unsigned char *)(text ? text : ""); *p; p++) {
    if (*p == '"' || *p == '\\') { out[len++] = '\\'; out[len++] = (char)*p; }
    else if (*p == '\n') { out[len++] = '\\'; out[len++] = 'n'; }
    else if (*p >= 0x20) out[len++] = (char)*p;
  }
  len += (size_t)snprintf(out + len, cap - len, "\"%s}", dpy ? "" : ",\"error\":\"no X display\"");
  emit(out);
  free(out);
  free(text);
}
