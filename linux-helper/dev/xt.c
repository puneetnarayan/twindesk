// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// xt: fake input through XTest for helper-test.js (xdotool misplaces the pointer on some
// displays, and `xdotool key Control_R` also presses other keys). Commands, one or more:
//   move X Y | rel DX DY | key XKEYCODE | tap XKEYCODE TIMES GAP_MS | click XBUTTON | sleep MS
// gcc -O2 -o xt xt.c -lX11 -lXtst
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "no display\n"); return 1; }
  for (int i = 1; i < argc; i++) {
    const char *c = argv[i];
    int a = i + 1 < argc ? atoi(argv[i + 1]) : 0, b = i + 2 < argc ? atoi(argv[i + 2]) : 0;
    if (!strcmp(c, "move")) { XTestFakeMotionEvent(d, -1, a, b, 0); i += 2; }
    else if (!strcmp(c, "rel")) { XTestFakeRelativeMotionEvent(d, a, b, 0); i += 2; }
    else if (!strcmp(c, "key")) { XTestFakeKeyEvent(d, a, True, 0); XFlush(d); usleep(20000); XTestFakeKeyEvent(d, a, False, 0); i += 1; }
    else if (!strcmp(c, "click")) { XTestFakeButtonEvent(d, a, True, 0); XFlush(d); usleep(20000); XTestFakeButtonEvent(d, a, False, 0); i += 1; }
    else if (!strcmp(c, "tap")) {
      int gap = i + 3 < argc ? atoi(argv[i + 3]) : 120;
      for (int n = 0; n < b; n++) {
        XTestFakeKeyEvent(d, a, True, 0); XFlush(d); usleep(30000);
        XTestFakeKeyEvent(d, a, False, 0); XFlush(d); usleep(gap * 1000);
      }
      i += 3;
    } else if (!strcmp(c, "sleep")) { XFlush(d); usleep(a * 1000); i += 1; }
    else { fprintf(stderr, "unknown: %s\n", c); return 2; }
    XFlush(d);
  }
  XSync(d, False);
  return 0;
}
