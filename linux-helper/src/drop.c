// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drag files across the edge, this computer → the other one (X11; port of windows-helper's
// DropEdge.cs). While the left button is held at home with edge crossing on, an invisible strip
// covers the outer edge facing the other computer: an XDND drop target. A file drag that enters
// it is accepted as a copy and its paths are read at once (XDND lets a target ask for the data
// before the drop); then the drag crosses (capture.c, capture_drag_cross). X can't end another
// client's drag the way Windows' marked button-up does, so the file manager's drag stays parked
// on the strip (a pointer barrier holds the pointer there) while motion and the button go to the
// other computer; the real button-up drops it there, and here on the strip, which does nothing.
// The window and its XDND messages live on the injection connection (events from main.c).
#include "helper.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xatom.h>

#define STRIP 2 // px

static int dragFiles = 1;
static Window strip;
static int shown, sx, sy, sw, sh;
static Window source;   // the drag over the strip
static int hasUris, requested, taken;
static double takenAt;
static Atom A_AWARE, A_ENTER, A_POSITION, A_STATUS, A_LEAVE, A_DROP, A_FINISHED, A_SELECTION, A_TYPELIST, A_COPY, A_URIS, A_PROP;

void drop_config(const JObj *c) { dragFiles = jbool(c, "dragFiles", 1); }

static Atom atom(const char *n) { return XInternAtom(dpy_in, n, False); }

static void make(void) {
  if (strip) return;
  A_AWARE = atom("XdndAware"); A_ENTER = atom("XdndEnter"); A_POSITION = atom("XdndPosition"); A_STATUS = atom("XdndStatus");
  A_LEAVE = atom("XdndLeave"); A_DROP = atom("XdndDrop"); A_FINISHED = atom("XdndFinished"); A_SELECTION = atom("XdndSelection");
  A_TYPELIST = atom("XdndTypeList"); A_COPY = atom("XdndActionCopy"); A_URIS = atom("text/uri-list"); A_PROP = atom("TWINDESK_DROP");
  XSetWindowAttributes a;
  memset(&a, 0, sizeof a);
  a.override_redirect = True;
  a.background_pixmap = None; // shows what's under it: invisible without a compositor too
  strip = XCreateWindow(dpy_in, root_in, 0, 0, 1, 1, 0, CopyFromParent, InputOutput, CopyFromParent, CWOverrideRedirect | CWBackPixmap, &a);
  long version = 5;
  XChangeProperty(dpy_in, strip, A_AWARE, XA_ATOM, 32, PropModeReplace, (unsigned char *)&version, 1);
  Atom type = atom("_NET_WM_WINDOW_TYPE_DND"); // no shadow from compositors
  XChangeProperty(dpy_in, strip, atom("_NET_WM_WINDOW_TYPE"), XA_ATOM, 32, PropModeReplace, (unsigned char *)&type, 1);
  XStoreName(dpy_in, strip, "TwinDesk drop edge");
}

static void hide(void) {
  if (!shown) return;
  XUnmapWindow(dpy_in, strip);
  XFlush(dpy_in);
  shown = 0;
}

static void reset(void) {
  source = 0;
  hasUris = requested = taken = 0;
}

// Shown only while the left button is held at home with edge crossing on, along the outer edge of
// the monitor under the pointer.
void drop_tick(int capturing, int side, int driveOther, int leftDown) {
  if (taken) {
    if (now_ms() - takenAt > 60000) { reset(); hide(); } // a drag that never ended
    return;
  }
  if (!leftDown && !shown) return;
  Window rr, cr;
  int x = 0, y = 0, wx, wy, mx, my, mw, mh;
  unsigned mask = 0;
  XQueryPointer(dpy_in, root_in, &rr, &cr, &x, &y, &wx, &wy, &mask);
  int want = dragFiles && driveOther && side != SIDE_NONE && !capturing && leftDown && (mask & Button1Mask) && screens_monitor(x, y, &mx, &my, &mw, &mh);
  if (want) {
    int px = side == SIDE_LEFT ? mx : side == SIDE_RIGHT ? mx + mw - 1 : x;
    int py = side == SIDE_TOP ? my : side == SIDE_BOTTOM ? my + mh - 1 : y;
    want = screens_on_outer_edge(px, py, side);
  }
  if (!want) {
    if (!source) hide(); // a drag still over it keeps it until it leaves
    return;
  }
  make();
  int nx = side == SIDE_RIGHT ? mx + mw - STRIP : mx, ny = side == SIDE_BOTTOM ? my + mh - STRIP : my;
  int nw = side == SIDE_LEFT || side == SIDE_RIGHT ? STRIP : mw, nh = side == SIDE_TOP || side == SIDE_BOTTOM ? STRIP : mh;
  if (!shown || nx != sx || ny != sy || nw != sw || nh != sh) {
    sx = nx; sy = ny; sw = nw; sh = nh;
    XMoveResizeWindow(dpy_in, strip, sx, sy, (unsigned)sw, (unsigned)sh);
  }
  if (!shown) { XMapRaised(dpy_in, strip); shown = 1; }
  XFlush(dpy_in);
}

static void reply(Window to, Atom type, long l1, long l4) {
  XEvent e;
  memset(&e, 0, sizeof e);
  e.xclient.type = ClientMessage;
  e.xclient.display = dpy_in;
  e.xclient.window = to;
  e.xclient.message_type = type;
  e.xclient.format = 32;
  e.xclient.data.l[0] = (long)strip;
  e.xclient.data.l[1] = l1;
  if (type == A_FINISHED) e.xclient.data.l[2] = l4;
  else e.xclient.data.l[4] = l4;
  XSendEvent(dpy_in, to, False, NoEventMask, &e);
  XFlush(dpy_in);
}

// file:///a%20b → /a b (other schemes are skipped). Appends the JSON string to out.
static int put_path(char *out, size_t cap, size_t *len, const char *uri, size_t n, int first) {
  if (n < 8 || strncmp(uri, "file://", 7)) return 0;
  const char *p = memchr(uri + 7, '/', n - 7); // after the (usually empty) host
  if (!p) return 0;
  const char *end = uri + n;
  if (*len + (size_t)(end - p) * 6 + 8 > cap) return 0;
  char *o = out + *len;
  if (!first) *o++ = ',';
  *o++ = '"';
  for (; p < end; p++) {
    int c = (unsigned char)*p;
    if (c == '%' && end - p > 2) {
      char hex[3] = { p[1], p[2], 0 };
      c = (int)strtol(hex, NULL, 16);
      p += 2;
    }
    if (c == '"' || c == '\\') { *o++ = '\\'; *o++ = (char)c; }
    else if (c >= 0x20) *o++ = (char)c;
  }
  *o++ = '"';
  *len = (size_t)(o - out);
  return 1;
}

static void got_uris(void) {
  Atom type;
  int fmt;
  unsigned long n = 0, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy_in, strip, A_PROP, 0, 1 << 20, True, AnyPropertyType, &type, &fmt, &n, &after, &data) != Success || !data) return;
  if (fmt != 8 || type == atom("INCR")) { XFree(data); return; } // a list too big for one property: not taken
  size_t cap = n * 6 + 16, len = 0;
  char *out = malloc(cap);
  out[len++] = '[';
  int count = 0;
  const char *s = (const char *)data, *end = s + n;
  while (s < end) {
    const char *nl = memchr(s, '\n', (size_t)(end - s));
    const char *e = nl ? nl : end;
    size_t l = (size_t)(e - s);
    while (l && (s[l - 1] == '\r' || s[l - 1] == 0)) l--;
    if (l && s[0] != '#' && put_path(out, cap, &len, s, l, count == 0)) count++;
    s = nl ? nl + 1 : end;
  }
  out[len++] = ']';
  out[len] = 0;
  XFree(data);
  if (count && !taken && !capture_active()) {
    Window rr, cr;
    int x = 0, y = 0, wx, wy;
    unsigned m;
    XQueryPointer(dpy_in, root_in, &rr, &cr, &x, &y, &wx, &wy, &m);
    taken = 1;
    takenAt = now_ms();
    capture_drag_cross(out, x, y, sx, sy, sw, sh);
  }
  free(out);
}

void drop_xevent(XEvent *e) {
  if (!strip) return;
  if (e->type == SelectionNotify && e->xselection.requestor == strip) {
    if (e->xselection.property != None) got_uris();
    return;
  }
  if (e->type != ClientMessage || e->xclient.window != strip) return;
  Atom t = e->xclient.message_type;
  long *l = e->xclient.data.l;
  if (t == A_ENTER) {
    reset();
    source = (Window)l[0];
    if (l[1] & 1) { // more than three types: the list is on the source
      Atom type, *list = NULL;
      int fmt;
      unsigned long n = 0, after;
      if (XGetWindowProperty(dpy_in, source, A_TYPELIST, 0, 256, False, XA_ATOM, &type, &fmt, &n, &after, (unsigned char **)&list) == Success && list) {
        for (unsigned long i = 0; i < n; i++) if (list[i] == A_URIS) hasUris = 1;
        XFree(list);
      }
    } else {
      for (int i = 2; i < 5; i++) if ((Atom)l[i] == A_URIS) hasUris = 1;
    }
  } else if (t == A_POSITION) {
    if ((Window)l[0] != source) return;
    int ok = hasUris && dragFiles;
    if (ok && !requested && !taken) {
      XConvertSelection(dpy_in, A_SELECTION, A_URIS, A_PROP, strip, (Time)l[3]);
      requested = 1;
    }
    reply(source, A_STATUS, ok ? 1 : 0, ok ? (long)A_COPY : 0); // never Move: the source would delete the files
  } else if (t == A_LEAVE) {
    if (!taken) { reset(); hide(); }
  } else if (t == A_DROP) {
    Window src = (Window)l[0];
    int was = taken;
    reply(src, A_FINISHED, was ? 1 : 0, was ? (long)A_COPY : 0);
    reset();
    hide();
    if (was) capture_drag_dropped(); // the file manager let go: capture can take its grabs now
  }
}

void drop_shutdown(void) {
  if (strip) { XDestroyWindow(dpy_in, strip); strip = 0; shown = 0; XFlush(dpy_in); }
}
