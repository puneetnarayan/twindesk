// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Wayland backend: on Wayland no client may read or inject global input,
// so the helper goes under the compositor instead: it reads the keyboards, mice and touchpads
// from /dev/input (the `input` group, set up once from Setup), grabs them (EVIOCGRAB) while this
// computer drives the other one, and injects through two uinput devices (/dev/uinput): an absolute
// pointer (moves land exactly where we say, no second acceleration) and a keyboard + relative mouse
// for buttons, wheel and keys. Same commands and events as the X11 backend (main.c, capture.c).
//
// The compositor never tells anyone where the pointer is, so we follow it: our own moves are exact,
// the user's are dead-reckoned from the mice's deltas with an acceleration curve close to
// libinput's default, clamped to the monitors (which main sends with `screens`). Pinned against
// an edge both agree again, which is where the edge push is measured.
#include "helper.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <linux/input.h>
#include <linux/uinput.h>

#define NAME_PREFIX "TwinDesk virtual"
#define ABS_MAXV 65535
#define MAX_IN 32

enum { K_MOUSE = 1, K_PAD = 2, K_KBD = 4 };
typedef struct {
  int fd, kind, grabbed;
  char path[300];
  int absX, absY, touching, hasLast; // touchpad: single-finger motion
  double lastX, lastY, scaleX, scaleY;
} In;

static In ins[MAX_IN];
static int nin;
static int uabs = -1, urel = -1;
static double lastScan;

// config (kvmConfig), as capture.c
static int side = SIDE_NONE;
static double resistancePx = 120;
static int hotkeyEvs[2] = { 100, -1 };
static int driveOther, edgeKeyboard = 1;
static double deadmanMs = 1500, doubleTapMs = 400;
static double speed = 1.0;

// state
static double px, py;                 // where we think the pointer is (logical px)
static int capturing, capMouse, capKeys, wantCapture, wantMouse, wantKeys;
static double wantSince, lastCmd;
static unsigned char localKeys[256], localButtons[8];
static unsigned char sentKeys[256], sentButtons[8];
static double push, lastPush;
static int retArmed, retSide = SIDE_NONE;
static double retResistance, retPush, retLast;
static int hkDown;
static double lastTapUp = -1;
static int hkPending = -1;
static unsigned char hkRemote[256];
static unsigned char injKeys[256], injButtons[8];
static double vrem, hrem, lastMoveAt;

static void forward(const char *k) {
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "ev");
  jo_raw(&o, "ev", k);
  emit(jo_end(&o));
}

static int test_bit(const unsigned long *bits, int n) {
  return (bits[n / (8 * sizeof(long))] >> (n % (8 * sizeof(long)))) & 1;
}

// ---- uinput ----

static void uemit(int fd, int type, int code, int value) {
  if (fd < 0) return;
  struct input_event ie;
  memset(&ie, 0, sizeof ie);
  ie.type = (unsigned short)type;
  ie.code = (unsigned short)code;
  ie.value = value;
  if (write(fd, &ie, sizeof ie) < 0) { /* full: dropped */ }
}

static void usyn(int fd) { uemit(fd, EV_SYN, SYN_REPORT, 0); }

static int make_device(int absolute) {
  int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return -1;
  ioctl(fd, UI_SET_EVBIT, EV_KEY);
  ioctl(fd, UI_SET_EVBIT, EV_SYN);
  ioctl(fd, UI_SET_KEYBIT, BTN_LEFT);
  ioctl(fd, UI_SET_KEYBIT, BTN_RIGHT);
  ioctl(fd, UI_SET_KEYBIT, BTN_MIDDLE);
  if (absolute) {
    ioctl(fd, UI_SET_EVBIT, EV_ABS);
    ioctl(fd, UI_SET_ABSBIT, ABS_X);
    ioctl(fd, UI_SET_ABSBIT, ABS_Y);
  } else {
    ioctl(fd, UI_SET_KEYBIT, BTN_SIDE);
    ioctl(fd, UI_SET_KEYBIT, BTN_EXTRA);
    for (int k = 1; k < 249; k++) ioctl(fd, UI_SET_KEYBIT, k);
    ioctl(fd, UI_SET_EVBIT, EV_REL);
    ioctl(fd, UI_SET_RELBIT, REL_X);
    ioctl(fd, UI_SET_RELBIT, REL_Y);
    ioctl(fd, UI_SET_RELBIT, REL_WHEEL);
    ioctl(fd, UI_SET_RELBIT, REL_HWHEEL);
  }
  struct uinput_setup us;
  memset(&us, 0, sizeof us);
  us.id.bustype = BUS_VIRTUAL;
  us.id.vendor = 0x1209;
  us.id.product = absolute ? 0x7d01 : 0x7d02;
  snprintf(us.name, sizeof us.name, NAME_PREFIX " %s", absolute ? "pointer" : "keyboard");
  if (ioctl(fd, UI_DEV_SETUP, &us) < 0) { close(fd); return -1; }
  if (absolute) {
    for (int a = 0; a < 2; a++) {
      struct uinput_abs_setup ab;
      memset(&ab, 0, sizeof ab);
      ab.code = a ? ABS_Y : ABS_X;
      ab.absinfo.minimum = 0;
      ab.absinfo.maximum = ABS_MAXV;
      ioctl(fd, UI_ABS_SETUP, &ab);
    }
  }
  if (ioctl(fd, UI_DEV_CREATE) < 0) { close(fd); return -1; }
  return fd;
}

// ---- reading /dev/input ----

static void close_in(int i) {
  if (ins[i].grabbed) ioctl(ins[i].fd, EVIOCGRAB, 0);
  close(ins[i].fd);
  ins[i] = ins[--nin];
}

static int known(const char *path) {
  for (int i = 0; i < nin; i++) if (!strcmp(ins[i].path, path)) return 1;
  return 0;
}

static void scan(void) {
  lastScan = now_ms();
  DIR *d = opendir("/dev/input");
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) && nin < MAX_IN) {
    if (strncmp(e->d_name, "event", 5)) continue;
    char path[300];
    snprintf(path, sizeof path, "/dev/input/%s", e->d_name);
    if (known(path)) continue;
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) continue;
    char name[256] = "";
    ioctl(fd, EVIOCGNAME(sizeof name), name);
    if (!strncmp(name, NAME_PREFIX, strlen(NAME_PREFIX))) { close(fd); continue; } // ours (rule 4)
    unsigned long ev[(EV_CNT + 63) / 64] = { 0 }, key[(KEY_CNT + 63) / 64] = { 0 }, rel[(REL_CNT + 63) / 64] = { 0 }, abs[(ABS_CNT + 63) / 64] = { 0 };
    ioctl(fd, EVIOCGBIT(0, sizeof ev), ev);
    ioctl(fd, EVIOCGBIT(EV_KEY, sizeof key), key);
    ioctl(fd, EVIOCGBIT(EV_REL, sizeof rel), rel);
    ioctl(fd, EVIOCGBIT(EV_ABS, sizeof abs), abs);
    int kind = 0;
    if (test_bit(ev, EV_REL) && test_bit(rel, REL_X) && test_bit(rel, REL_Y)) kind |= K_MOUSE;
    if (test_bit(ev, EV_ABS) && test_bit(abs, ABS_X) && test_bit(key, BTN_TOOL_FINGER) && !test_bit(key, BTN_TOOL_PEN)) kind |= K_PAD;
    if (test_bit(ev, EV_KEY) && test_bit(key, KEY_A) && test_bit(key, KEY_Z) && test_bit(key, KEY_SPACE)) kind |= K_KBD;
    if (!kind) { close(fd); continue; }
    In *in = &ins[nin++];
    memset(in, 0, sizeof *in);
    in->fd = fd;
    in->kind = kind;
    snprintf(in->path, sizeof in->path, "%s", path);
    if (kind & K_PAD) { // units → px: about 4 px per mm of finger travel
      struct input_absinfo ax, ay;
      in->scaleX = in->scaleY = 0.5;
      if (!ioctl(fd, EVIOCGABS(ABS_X), &ax) && ax.resolution > 0) in->scaleX = 4.0 / ax.resolution;
      if (!ioctl(fd, EVIOCGABS(ABS_Y), &ay) && ay.resolution > 0) in->scaleY = 4.0 / ay.resolution;
    }
    if (capturing) { ioctl(fd, EVIOCGRAB, 1); in->grabbed = 1; }
    fprintf(stderr, "input: %s (%s%s%s)\n", name, kind & K_MOUSE ? "mouse " : "", kind & K_PAD ? "touchpad " : "", kind & K_KBD ? "keyboard" : "");
  }
  closedir(d);
}

static void grab_all(int on) {
  for (int i = 0; i < nin; i++) {
    if (ins[i].grabbed == on) continue;
    if (ioctl(ins[i].fd, EVIOCGRAB, on ? 1 : 0) == 0 || !on) ins[i].grabbed = on;
  }
}

// ---- injection ----

static void abs_to(double x, double y) {
  int bx, by, bw, bh;
  screens_box(&bx, &by, &bw, &bh);
  int ax = (int)lround((x - bx) * ABS_MAXV / (bw > 1 ? bw - 1 : 1));
  int ay = (int)lround((y - by) * ABS_MAXV / (bh > 1 ? bh - 1 : 1));
  uemit(uabs, EV_ABS, ABS_X, ax < 0 ? 0 : ax > ABS_MAXV ? ABS_MAXV : ax);
  uemit(uabs, EV_ABS, ABS_Y, ay < 0 ? 0 : ay > ABS_MAXV ? ABS_MAXV : ay);
  usyn(uabs);
}

void wl_move_to(int x, int y) {
  int cx, cy;
  screens_clamp(x, y, (int)px, (int)py, &cx, &cy);
  px = cx; py = cy;
  abs_to(px, py);
}

static void feed_return(double dx, double dy);

static void inj_move(double dx, double dy) {
  int ix = (int)lround(px + dx), iy = (int)lround(py + dy), cx, cy;
  screens_clamp(ix, iy, (int)px, (int)py, &cx, &cy);
  px = (cx == ix) ? px + dx : cx;
  py = (cy == iy) ? py + dy : cy;
  abs_to(px, py);
  lastMoveAt = now_ms();
  feed_return(dx, dy);
}

static const int BTN[] = { BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA };

static void inj_button(int b, int down) {
  if (b < 0 || b > 4) return;
  injButtons[b] = (unsigned char)down;
  uemit(urel, EV_KEY, BTN[b], down);
  usyn(urel);
}

static void inj_wheel(double dx, double dy, int pixel) {
  double k = pixel ? 1.0 / 40 : 1.0;
  vrem += dy * k;
  hrem += dx * k;
  int v = 0, h = 0;
  while (vrem >= 1) { v--; vrem -= 1; } // DOM +dy = content down = REL_WHEEL -1
  while (vrem <= -1) { v++; vrem += 1; }
  while (hrem >= 1) { h++; hrem -= 1; }
  while (hrem <= -1) { h--; hrem += 1; }
  if (v) uemit(urel, EV_REL, REL_WHEEL, v);
  if (h) uemit(urel, EV_REL, REL_HWHEEL, h);
  if (v || h) usyn(urel);
}

static void inj_key(const char *code, int down) {
  int ev = key_evdev(code);
  if (ev < 1 || ev > 248) return;
  injKeys[ev] = (unsigned char)down;
  uemit(urel, EV_KEY, ev, down);
  usyn(urel);
}

void wl_release_all(void) {
  for (int i = 0; i < 256; i++) if (injKeys[i]) { injKeys[i] = 0; uemit(urel, EV_KEY, i, 0); }
  for (int b = 0; b < 5; b++) if (injButtons[b]) { injButtons[b] = 0; uemit(urel, EV_KEY, BTN[b], 0); }
  usyn(urel);
  vrem = hrem = 0;
}

void wl_inject(const JObj *ev) {
  const char *t = jstr(ev, "t", "");
  if (!strcmp(t, "k.mm")) inj_move(jnum(ev, "dx", 0), jnum(ev, "dy", 0));
  else if (!strcmp(t, "k.md")) inj_button((int)jnum(ev, "b", -1), 1);
  else if (!strcmp(t, "k.mu")) inj_button((int)jnum(ev, "b", -1), 0);
  else if (!strcmp(t, "k.wh")) inj_wheel(jnum(ev, "dx", 0), jnum(ev, "dy", 0), !strcmp(jstr(ev, "mode", "line"), "pixel"));
  else if (!strcmp(t, "k.kd")) inj_key(jstr(ev, "code", NULL), 1);
  else if (!strcmp(t, "k.ku")) inj_key(jstr(ev, "code", NULL), 0);
}

// ---- capture ----

static int any(const unsigned char *a, int n) {
  for (int i = 0; i < n; i++) if (a[i]) return 1;
  return 0;
}

static int really_begin(int mouse, int keys) {
  grab_all(1);
  capturing = 1; capMouse = mouse; capKeys = keys;
  wantCapture = 0;
  memset(sentKeys, 0, sizeof sentKeys);
  memset(sentButtons, 0, sizeof sentButtons);
  lastCmd = now_ms();
  push = 0;
  return 1;
}

// Grabbing while a key or button is down would leave it pressed for the compositor (it never sees
// the release): wait until everything is up (at most a second, then go anyway).
int wl_capture_begin(int mouse, int keys) {
  if (capturing) { capMouse = mouse; capKeys = keys; return 1; }
  if (!any(localKeys, 256) && !any(localButtons, 8)) return really_begin(mouse, keys);
  wantCapture = 1; wantMouse = mouse; wantKeys = keys; wantSince = now_ms();
  return 1;
}

void wl_capture_stop(int toSide, double offset, int hasSide) {
  wantCapture = 0;
  if (!capturing) return;
  capturing = 0;
  hkPending = -1;
  memset(hkRemote, 0, sizeof hkRemote);
  // What is still held was pressed over there: let it go there (the other side's releaseAll does
  // too); the compositor never saw those presses, so their releases are harmless here.
  grab_all(0);
  if (capMouse && hasSide && toSide != SIDE_NONE) {
    int x, y;
    screens_edge_point(toSide, offset, &x, &y);
    wl_move_to(x, y);
  }
  push = 0;
}

void wl_arm_return(int on, int s, double resistance) {
  retArmed = on && s != SIDE_NONE;
  retSide = s;
  retResistance = resistance;
  retPush = 0;
}

static void feed_return(double dx, double dy) {
  if (!retArmed) return;
  double outward = screens_outward(retSide, dx, dy);
  if (outward <= 0 || !screens_on_outer_edge((int)px, (int)py, retSide)) { retPush = 0; return; }
  double now = now_ms();
  if (now - retLast > 300) retPush = 0;
  retLast = now;
  retPush += outward;
  if (retPush < retResistance) return;
  retArmed = 0;
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "return");
  jo_num(&o, "offset", round(screens_offset((int)px, (int)py, retSide) * 10000) / 10000);
  emit(jo_end(&o));
}

void wl_config(const JObj *c) {
  side = side_of(jstr(c, "side", NULL));
  resistancePx = jnum(c, "resistancePx", 120);
  const char *hk = jstr(c, "hotkey", "AltRight");
  char l[24], r[24];
  snprintf(l, sizeof l, "%sLeft", hk);
  snprintf(r, sizeof r, "%sRight", hk);
  int one = key_evdev(hk), left = key_evdev(l), right = key_evdev(r);
  if (one > 0) { hotkeyEvs[0] = one; hotkeyEvs[1] = -1; }
  else if (left > 0 && right > 0) { hotkeyEvs[0] = left; hotkeyEvs[1] = right; }
  else { hotkeyEvs[0] = 100; hotkeyEvs[1] = -1; }
  driveOther = jbool(c, "driveOther", 0);
  edgeKeyboard = jbool(c, "keyboard", 1);
  deadmanMs = jnum(c, "deadmanMs", 1500);
  doubleTapMs = jnum(c, "doubleTapMs", 400);
  shortcut_config(c);
}

void wl_touch(void) { lastCmd = now_ms(); }
int wl_active(void) { return capturing; }
void wl_position(int *x, int *y) { *x = (int)px; *y = (int)py; }

// ---- local input ----

static int is_hotkey(int ev) { return ev == hotkeyEvs[0] || ev == hotkeyEvs[1]; }

static int detect_hotkey(int ev, int down) {
  double now = now_ms();
  if (!is_hotkey(ev)) {
    if (down) lastTapUp = -1;
    return 0;
  }
  if (down) { hkDown = 1; return 0; }
  if (!hkDown) return 0;
  hkDown = 0;
  if (lastTapUp >= 0 && now - lastTapUp <= doubleTapMs) { lastTapUp = -1; return 1; }
  lastTapUp = now;
  return 0;
}

static void fire_hotkey(void) {
  int was = capturing;
  if (capturing) wl_capture_stop(SIDE_NONE, 0, 0);
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "hotkey");
  jo_bool(&o, "wasCapturing", was);
  emit(jo_end(&o));
}

static void send_key(int ev, int down) {
  const char *code = key_code(ev);
  if (!code) return;
  JOut k;
  jo_begin(&k);
  jo_str(&k, "t", down ? "k.kd" : "k.ku");
  jo_str(&k, "code", code);
  forward(jo_end(&k));
}

static void flush_hotkey(void) {
  int ev = hkPending;
  hkPending = -1;
  if (ev < 0 || !capturing || !capKeys) return;
  hkRemote[ev] = 1;
  sentKeys[ev] = 1;
  send_key(ev, 1);
}

// value: 1 down, 0 up, 2 autorepeat (sent as another k.kd, like the PC)
static void on_key(int ev, int value) {
  if (ev < 0 || ev > 255) return;
  if (value != 2) { localKeys[ev] = (unsigned char)value; shortcut_key(ev, value, !capturing); }
  int hot = value == 2 ? 0 : detect_hotkey(ev, value);
  if (capturing && capKeys) {
    if (is_hotkey(ev)) {
      if (value == 1) { if (!hkRemote[ev]) hkPending = ev; }
      else if (value == 0) {
        if (hkRemote[ev]) { hkRemote[ev] = 0; sentKeys[ev] = 0; send_key(ev, 0); }
        else if (hkPending == ev) hkPending = -1;
      }
      if (hot) fire_hotkey();
      return;
    }
    if (value) flush_hotkey();
    if (value == 0 && !sentKeys[ev]) { if (hot) fire_hotkey(); return; } // pressed before capture
    sentKeys[ev] = value != 0;
    send_key(ev, value != 0);
  }
  if (hot) fire_hotkey();
}

static void on_button(int code, int down) {
  int b = code == BTN_LEFT ? 0 : code == BTN_RIGHT ? 1 : code == BTN_MIDDLE ? 2 : code == BTN_SIDE ? 3 : code == BTN_EXTRA ? 4 : -1;
  if (b < 0) return;
  localButtons[b] = (unsigned char)down;
  if (!capturing || !capMouse) return;
  if (!down && !sentButtons[b]) return;
  if (down) flush_hotkey();
  sentButtons[b] = (unsigned char)down;
  JOut k;
  jo_begin(&k);
  jo_str(&k, "t", down ? "k.md" : "k.mu");
  jo_num(&k, "b", b);
  forward(jo_end(&k));
}

static void on_wheel(int horiz, int v) {
  if (!capturing || !capMouse || !v) return;
  JOut k;
  jo_begin(&k);
  jo_str(&k, "t", "k.wh");
  jo_num(&k, "dx", horiz ? v : 0);
  jo_num(&k, "dy", horiz ? 0 : -v);
  jo_str(&k, "mode", "line");
  forward(jo_end(&k));
}

// libinput's default (adaptive) profile, roughly: slow hands 1:1, faster ones up to ~3x.
static double accel(double dx, double dy, double dtMs) {
  double v = sqrt(dx * dx + dy * dy) / (dtMs > 1 ? dtMs : 1); // units per ms
  double f = v < 0.35 ? 1.0 : 1.0 + (v - 0.35) * 1.6;
  return (f > 3.2 ? 3.2 : f) * speed;
}

static double lastMotion;

static void on_motion(double rdx, double rdy) {
  double now = now_ms();
  double f = accel(rdx, rdy, now - lastMotion);
  lastMotion = now;
  double dx = rdx * f, dy = rdy * f;
  if (capturing) {
    if (!capMouse || (dx == 0 && dy == 0)) return;
    JOut k;
    jo_begin(&k);
    jo_str(&k, "t", "k.mm");
    jo_num(&k, "dx", round(dx * 100) / 100);
    jo_num(&k, "dy", round(dy * 100) / 100);
    forward(jo_end(&k));
    return;
  }
  // Follow the pointer.
  int ix = (int)lround(px + dx), iy = (int)lround(py + dy), cx, cy;
  screens_clamp(ix, iy, (int)px, (int)py, &cx, &cy);
  px = cx; py = cy;
  if (retArmed) { feed_return(rdx, rdy); return; }
  if (!driveOther || side == SIDE_NONE || any(localButtons, 8)) { push = 0; return; } // rule 6
  double outward = screens_outward(side, rdx, rdy);
  if (outward <= 0 || !screens_on_outer_edge((int)px, (int)py, side)) { push = 0; return; }
  if (now - lastPush > 300) push = 0;
  lastPush = now;
  push += outward;
  if (push < resistancePx) return;
  double offset = screens_offset((int)px, (int)py, side);
  really_begin(1, edgeKeyboard);
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "edge");
  jo_num(&o, "offset", round(offset * 10000) / 10000);
  emit(jo_end(&o));
}

static void read_in(int i) {
  In *in = &ins[i];
  struct input_event evs[64];
  double mdx = 0, mdy = 0;
  for (;;) {
    ssize_t n = read(in->fd, evs, sizeof evs);
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) break;
      fprintf(stderr, "input: %s gone\n", in->path);
      close_in(i);
      return;
    }
    if (n == 0) break;
    for (int k = 0; k < (int)(n / (ssize_t)sizeof evs[0]); k++) {
      struct input_event *e = &evs[k];
      if (e->type == EV_KEY) {
        if (e->code >= BTN_MOUSE && e->code < BTN_JOYSTICK) on_button(e->code, e->value != 0);
        else if (e->code == BTN_TOUCH) { in->touching = e->value != 0; in->hasLast = 0; }
        else if (e->code < 256) on_key(e->code, e->value);
      } else if (e->type == EV_REL) {
        if (e->code == REL_X) mdx += e->value;
        else if (e->code == REL_Y) mdy += e->value;
        else if (e->code == REL_WHEEL) on_wheel(0, e->value);
        else if (e->code == REL_HWHEEL) on_wheel(1, e->value);
      } else if (e->type == EV_ABS && (in->kind & K_PAD)) {
        if (e->code == ABS_X) in->absX = e->value;
        else if (e->code == ABS_Y) in->absY = e->value;
      } else if (e->type == EV_SYN && e->code == SYN_REPORT) {
        if ((in->kind & K_PAD) && in->touching) {
          if (in->hasLast) { mdx += (in->absX - in->lastX) * in->scaleX; mdy += (in->absY - in->lastY) * in->scaleY; }
          in->lastX = in->absX; in->lastY = in->absY; in->hasLast = 1;
        }
        if (mdx != 0 || mdy != 0) { on_motion(mdx, mdy); mdx = mdy = 0; }
      }
    }
  }
}

// ---- loop ----

int wl_init(void) {
  uabs = make_device(1);
  urel = make_device(0);
  if (uabs < 0 || urel < 0) {
    fprintf(stderr, "no access to /dev/uinput (%s)\n", strerror(errno));
    return 0;
  }
  scan();
  if (!nin) fprintf(stderr, "no readable devices in /dev/input: crossing and the hotkey need the input group\n");
  // Somewhere sane until the first `screens` and moves.
  int cx, cy;
  screens_center(&cx, &cy);
  px = cx; py = cy;
  lastCmd = now_ms();
  const char *s = getenv("MACSHARE_HELPER_SPEED");
  if (s && atof(s) > 0) speed = atof(s);
  return 1;
}

int wl_fds(struct pollfd *p, int max) {
  int n = 0;
  for (int i = 0; i < nin && n < max; i++) p[n++] = (struct pollfd){ ins[i].fd, POLLIN, 0 };
  return n;
}

void wl_read(struct pollfd *p, int n) {
  // Back to front: close_in moves the last device into the hole.
  for (int k = n - 1; k >= 0; k--) {
    if (!(p[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
    for (int i = 0; i < nin; i++) if (ins[i].fd == p[k].fd) { read_in(i); break; }
  }
}

void wl_tick(void) {
  double now = now_ms();
  shortcut_tick();
  if (now - lastScan > 3000) scan(); // hot-plugged devices
  if (wantCapture && ((!any(localKeys, 256) && !any(localButtons, 8)) || now - wantSince > 1000)) really_begin(wantMouse, wantKeys);
  if (capturing && now - lastCmd > deadmanMs) {
    wl_capture_stop(SIDE_NONE, 0, 0);
    JOut o;
    jo_begin(&o);
    jo_str(&o, "event", "captureEnded");
    jo_str(&o, "reason", "deadman");
    emit(jo_end(&o));
  }
}

void wl_shutdown(void) {
  if (capturing) wl_capture_stop(SIDE_NONE, 0, 0);
  wl_release_all();
  grab_all(0);
  if (uabs >= 0) { ioctl(uabs, UI_DEV_DESTROY); close(uabs); uabs = -1; }
  if (urel >= 0) { ioctl(urel, UI_DEV_DESTROY); close(urel); urel = -1; }
}

int wl_devices(void) { return nin; }
