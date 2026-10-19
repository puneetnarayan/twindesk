// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The copy/paste-files shortcuts at home (linux/fclip.js), for both backends: Electron's
// globalShortcut needs X11 and an X window in front, so the helper, which reads every key anyway
// (the hotkey), watches for them. The keys still reach the app in front (nothing is grabbed);
// once the combination is complete we wait for every key to come up (or 1.5 s), then tell main
// `shortcut {action}`, so whatever main sends the app next (Ctrl+C in the file manager) arrives
// with no modifier still held.
#include "helper.h"
#include <stdio.h>
#include <string.h>

enum { M_CTRL = 1, M_ALT = 2, M_SHIFT = 4, M_SUPER = 8 };

typedef struct { int mods, key; const char *action; } Combo;
static Combo combos[2] = { { 0, -1, "copy" }, { 0, -1, "paste" } };
static int on;
static unsigned char held[256];
static int pending = -1;
static double pendingAt;

static int mod_of(int ev) {
  switch (ev) {
    case 29: case 97: return M_CTRL;
    case 56: case 100: return M_ALT;
    case 42: case 54: return M_SHIFT;
    case 125: case 126: return M_SUPER;
    default: return 0;
  }
}

// "Control+Alt+C" (an Electron accelerator, settings.files.copyKeys) → mods + evdev key.
static void parse(Combo *c, const char *acc) {
  c->mods = 0;
  c->key = -1;
  char buf[64];
  snprintf(buf, sizeof buf, "%s", acc ? acc : "");
  char *save = NULL;
  for (char *p = strtok_r(buf, "+", &save); p; p = strtok_r(NULL, "+", &save)) {
    if (!strcmp(p, "Control") || !strcmp(p, "Ctrl") || !strcmp(p, "CommandOrControl") || !strcmp(p, "CmdOrCtrl")) c->mods |= M_CTRL;
    else if (!strcmp(p, "Alt") || !strcmp(p, "Option") || !strcmp(p, "AltGr")) c->mods |= M_ALT;
    else if (!strcmp(p, "Shift")) c->mods |= M_SHIFT;
    else if (!strcmp(p, "Super") || !strcmp(p, "Meta") || !strcmp(p, "Command") || !strcmp(p, "Cmd")) c->mods |= M_SUPER;
    else {
      char code[32];
      if (strlen(p) == 1 && p[0] >= 'A' && p[0] <= 'Z') snprintf(code, sizeof code, "Key%c", p[0]);
      else if (strlen(p) == 1 && p[0] >= 'a' && p[0] <= 'z') snprintf(code, sizeof code, "Key%c", p[0] - 32);
      else if (strlen(p) == 1 && p[0] >= '0' && p[0] <= '9') snprintf(code, sizeof code, "Digit%c", p[0]);
      else snprintf(code, sizeof code, "%s", p);
      c->key = key_evdev(code);
    }
  }
  if (!c->mods) c->key = -1; // a bare key would fire while typing
}

// kvmConfig: shortcuts (on/off), copyKeys, pasteKeys.
void shortcut_config(const JObj *c) {
  on = jbool(c, "shortcuts", 0);
  parse(&combos[0], jstr(c, "copyKeys", "Control+Alt+C"));
  parse(&combos[1], jstr(c, "pasteKeys", "Control+Alt+V"));
  if (!on) pending = -1;
}

// Every local key (not our own injection). detect: we're at home (while capturing, main's
// fclip.intercept sees the keys instead).
void shortcut_key(int ev, int down, int detect) {
  if (ev < 0 || ev > 255) return;
  held[ev] = (unsigned char)(down != 0);
  if (!down || !detect || !on || mod_of(ev)) return;
  int mods = 0;
  for (int i = 0; i < 256; i++) if (held[i]) mods |= mod_of(i);
  for (int i = 0; i < 2; i++) {
    if (combos[i].key == ev && combos[i].mods == mods) {
      pending = i;
      pendingAt = now_ms();
    }
  }
}

void shortcut_tick(void) {
  if (pending < 0) return;
  int any = 0;
  for (int i = 0; i < 256; i++) if (held[i]) { any = 1; break; }
  if (any && now_ms() - pendingAt < 1500) return;
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "shortcut");
  jo_str(&o, "action", combos[pending].action);
  emit(jo_end(&o));
  pending = -1;
}
